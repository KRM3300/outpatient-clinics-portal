-- تجربة المريض: النموذج الذكي لطلبات المواعيد + التنبيه الصوتي + صفحة إنتاجية الموظفين
-- إضافات فقط: أعمدة جديدة، صلاحيتان جديدتان، نشر الجدول للتحديث الفوري، ودالة أرقام مجمّعة.

-- 1) خانات المواعيد في البلاغ (الموعد الحالي/آخر موعد، والمطلوب، و«أقرب موعد متاح»)
alter table public.opd_pe_cases
  add column if not exists appt_current_date date,
  add column if not exists appt_current_period text check (appt_current_period in ('صباحية', 'ظهرية', 'مسائية')),
  add column if not exists appt_requested_date date,
  add column if not exists appt_requested_period text check (appt_requested_period in ('صباحية', 'ظهرية', 'مسائية')),
  add column if not exists appt_earliest boolean not null default false;

-- 2) صلاحيتان جديدتان: التنبيه الصوتي، والاطلاع على إنتاجية الموظفين
alter table public.opd_user_perms drop constraint if exists opd_user_perms_perm_check;
alter table public.opd_user_perms add constraint opd_user_perms_perm_check check (perm in (
  'appt_er_request', 'appt_fu_request', 'appt_er_handle', 'appt_fu_handle',
  'pe_submit', 'pe_handle', 'pe_supervisor', 'pe_alert', 'nc_submit', 'nc_view', 'kpi_view', 'guide_view', 'schedule_view',
  'prod_view'));

-- 3) التحديث الفوري لجدول البلاغات (يحترم صلاحيات القراءة الحالية)
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'opd_pe_cases') then
    alter publication supabase_realtime add table public.opd_pe_cases;
  end if;
end $$;

-- 4) إنتاجية الموظفين: أرقام مجمّعة فقط (بدون أسماء مرضى)، للمدير ولمن عنده prod_view
create or replace function public.opd_productivity(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb;
begin
  if not public.opd_has_perm('prod_view') then raise exception 'not allowed'; end if;
  with pe as (
    select c.*,
           (c.created_at at time zone 'Asia/Riyadh')::date as d,
           extract(epoch from (c.closed_at - c.created_at)) / 3600.0 as h
    from public.opd_pe_cases c
    where (c.created_at at time zone 'Asia/Riyadh')::date between p_from and p_to
  ),
  raised as (
    select coalesce(nullif(btrim(coalesce(pe_staff_name, created_by_name)), ''), 'غير محدد') as name,
           count(*) as total,
           count(*) filter (where status = 'closed') as closed,
           count(*) filter (where status <> 'closed') as open
    from pe group by 1
  ),
  closers as (
    select coalesce(nullif(btrim(opd_staff_name), ''), 'غير محدد') as name,
           count(*) as total,
           count(*) filter (where source = 'app' and h < 8) as green,
           count(*) filter (where source = 'app' and h >= 8 and h <= 24) as orange,
           count(*) filter (where source = 'app' and h > 24) as red,
           round(avg(h) filter (where source = 'app')::numeric, 1) as avg_h
    from pe where status = 'closed' group by 1
  ),
  nc as (
    select coalesce(nullif(btrim(reporter_name), ''), 'غير محدد') as name, count(*) as total
    from public.opd_nc_reports
    where (occurred_at at time zone 'Asia/Riyadh')::date between p_from and p_to
    group by 1
  )
  select jsonb_build_object(
    'pe_total', (select count(*) from pe),
    'pe_closed', (select count(*) from pe where status = 'closed'),
    'raised', coalesce((select jsonb_agg(to_jsonb(raised) order by total desc) from raised), '[]'),
    'closers', coalesce((select jsonb_agg(to_jsonb(closers) order by total desc) from closers), '[]'),
    'nc_total', (select coalesce(sum(total), 0) from nc),
    'nc', coalesce((select jsonb_agg(to_jsonb(nc) order by total desc) from nc), '[]')
  ) into r;
  return r;
end $$;
revoke all on function public.opd_productivity(date, date) from public;
grant execute on function public.opd_productivity(date, date) to authenticated;
