-- تقييم الأداء في العيادات الخارجية (2026-11-18) — إضافة فقط وقابل لإعادة التشغيل
-- السياسة: كل جدارة أصلها 4 وسقفها 5 (أدناها 1). سنة التقييم Y = من 1 ديسمبر (Y-1) إلى 30 نوفمبر (Y).
-- الخصوصية: التقارير الداخلية والتقييم يطّلع عليها المدير فقط. كاتب التقرير يرفع فقط ولا يرى شيئاً،
-- والموظف لا يرى التقارير ولا التقييم (يُناقش معه نهاية السنة). المبادرات/التعلم: صاحب الطلب يرى حالة طلبه فقط.

alter table public.opd_team add column if not exists perf_supervisor boolean not null default false;

create table if not exists public.opd_perf_reports (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.opd_team(id),
  kind text not null check (kind in ('positive', 'negative')),
  report_date date not null,
  items text[] not null check (cardinality(items) between 1 and 25),
  notes text check (length(notes) <= 1500),
  author uuid not null,
  author_name text,
  source text not null default 'portal' check (source in ('portal', 'google_form')),
  created_at timestamptz not null default now()
);
create index if not exists opd_perf_reports_staff on public.opd_perf_reports(staff_id, report_date);

create table if not exists public.opd_perf_contrib (
  id uuid primary key default gen_random_uuid(),
  ctype text not null check (ctype in ('initiative', 'procedure', 'explanation', 'lecture_given', 'lecture_attended', 'course')),
  title text not null check (length(title) between 3 and 300),
  problem text check (length(problem) <= 2000),
  solution text check (length(solution) <= 2000),
  implemented boolean,
  hours numeric(6,1) check (hours is null or hours between 0 and 1000),
  days integer check (days is null or days between 0 and 365),
  event_date date not null,
  participants uuid[] not null check (cardinality(participants) between 1 and 3),
  submitted_by uuid,
  submitter_name text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  source text not null default 'portal' check (source in ('portal', 'google_form')),
  created_at timestamptz not null default now()
);
create index if not exists opd_perf_contrib_date on public.opd_perf_contrib(event_date);

create table if not exists public.opd_perf_charter (
  staff_id uuid not null references public.opd_team(id),
  year integer not null check (year between 2024 and 2100),
  accepted_on date not null,
  primary key (staff_id, year)
);

alter table public.opd_perf_reports enable row level security;
alter table public.opd_perf_contrib enable row level security;
alter table public.opd_perf_charter enable row level security;
revoke all on table public.opd_perf_reports, public.opd_perf_contrib, public.opd_perf_charter from public, anon, authenticated;

-- صلاحية «تقييم الأداء: كتابة التقرير الداخلي» (perf_report) — إضافة للقائمة الموجودة دون حذف أي صلاحية
do $$
declare d text;
begin
  select pg_get_constraintdef(c.oid) into d from pg_constraint c
  where c.conname = 'opd_user_perms_perm_check' and c.conrelid = 'public.opd_user_perms'::regclass;
  if d is not null and position('perf_report' in d) = 0 and position(']' in d) > 0 then
    execute 'alter table public.opd_user_perms drop constraint opd_user_perms_perm_check';
    execute 'alter table public.opd_user_perms add constraint opd_user_perms_perm_check '
            || replace(d, ']', ', ''perf_report''::text]');
  end if;
end $$;

create or replace function public.opd_perf_is_member()
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (select 1 from public.opd_appt_members m where m.user_id = auth.uid() and m.status = 'approved');
$fn$;

-- أسماء موظفي العيادات (للاختيار في النماذج) — أسماء فقط
create or replace function public.opd_perf_staff_list()
returns table(id uuid, name text)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.opd_perf_is_member() then raise exception 'Not authorized'; end if;
  return query select t.id, t.name from public.opd_team t where t.active order by t.name;
end $fn$;

-- رفع تقرير داخلي: بصلاحية perf_report فقط، والبنود من القائمة المعتمدة
create or replace function public.opd_perf_report_submit(p_staff uuid, p_kind text, p_date date, p_items text[], p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $fn$
declare
  v_id uuid;
  v_allowed text[] := array[
    'يتحمل مسؤولية أعماله وقراراته، ولا يلقي اللوم على الآخرين',
    'يفهم دوره، وكيفية ارتباطه بالأهداف العامة لجهة عمله',
    'يفصح عن ما يواجهه من تحديات بشفافية',
    'يساهم في رفع كفاءة الإنفاق وإنجاز المهمة بإنتاجية أكبر بنفس الموارد أو أقل تكلفة',
    'يشارك المعلومات بانفتاح وفق متطلبات العمل',
    'يسعى إلى الاستفادة من آراء الآخرين وبناء علاقات داعمة',
    'يستجيب لطلبات الدعم والمساندة من الوحدات التنظيمية',
    'يستخدم التواصل المكتوب الواضح والفعال',
    'يستخدم التواصل الشفهي الواضح والفعال',
    'ينصت للآخرين بعناية',
    'يستطيع القيام بمهام متعددة وتحديد أولوياتها',
    'يمكن الاعتماد عليه، وينفذ مهامه في وقتها بجودة عالية',
    'مبادر ويعمل بدون توجيه من رئيسه',
    'تأخر عن بداية الدوام',
    'خروج الموظف بدون توقيع استئذان أو بدون إذن',
    'خروج الموظف بدون توقيع انصراف',
    'خروج الموظف قبل نهاية الشفت',
    'لديه الاستعداد لمواجهة تحديات العمل',
    'يتطلع إلى مستوى أعلى من الإنجاز والابتكار',
    'يركز على خدمة العملاء عند تنفيذ أعماله',
    'يلتزم بمواعيد العمل ويكون متواجداً عند الحاجة إليه',
    'يسعى إلى التعلم وتطوير نفسه باستمرار',
    'يساعد الآخرين على تطوير أنفسهم ومشاركة النصح والاقتراحات',
    'مرن وقادر على تنفيذ أعمال هامة في ظروف فيها مخاطرة وعدم يقين',
    'يدعم ويشجع فريقه على تحقيق أهدافه حتى في الظروف الصعبة',
    'يفكر بمنطقية وإبداع دون التأثر بتحيزاته الشخصية',
    'يفوض الصلاحيات ويتابع النتائج',
    'يوفر ويدعم فرص تطوير المرؤوسين'];
begin
  if not public.opd_has_perm('perf_report') then raise exception 'Not authorized'; end if;
  if p_kind not in ('positive', 'negative') then raise exception 'نوع التقرير غير صحيح'; end if;
  if p_date is null or p_date > (now() at time zone 'Asia/Riyadh')::date then raise exception 'تاريخ التقرير غير صحيح'; end if;
  if p_items is null or cardinality(p_items) = 0 or not (p_items <@ v_allowed) then raise exception 'اختر بنداً واحداً على الأقل من القائمة'; end if;
  if not exists (select 1 from public.opd_team t where t.id = p_staff and t.active) then raise exception 'الموظف غير موجود'; end if;
  insert into public.opd_perf_reports(staff_id, kind, report_date, items, notes, author, author_name)
  values (p_staff, p_kind, p_date, p_items, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid(),
          (select m.full_name from public.opd_appt_members m where m.user_id = auth.uid()))
  returning id into v_id;
  return v_id;
end $fn$;

-- رفع مبادرة / إجراء / شرح / محاضرة / دورة: لأي موظف معتمد في المنصة، وتنتظر اعتماد المدير
create or replace function public.opd_perf_contrib_submit(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $fn$
declare v_id uuid; v_parts uuid[];
begin
  if not public.opd_perf_is_member() then raise exception 'Not authorized'; end if;
  select array_agg(distinct x::uuid) into v_parts from jsonb_array_elements_text(coalesce(p->'participants', '[]'::jsonb)) x;
  if v_parts is null or cardinality(v_parts) not between 1 and 3 then raise exception 'اختر من موظف إلى 3 موظفين'; end if;
  if exists (select 1 from unnest(v_parts) u where not exists (select 1 from public.opd_team t where t.id = u)) then
    raise exception 'موظف غير موجود';
  end if;
  insert into public.opd_perf_contrib(ctype, title, problem, solution, implemented, hours, days, event_date, participants, submitted_by, submitter_name)
  values (p->>'ctype', btrim(p->>'title'), nullif(btrim(coalesce(p->>'problem', '')), ''), nullif(btrim(coalesce(p->>'solution', '')), ''),
          case when p ? 'implemented' and p->>'implemented' in ('true', 'false') then (p->>'implemented')::boolean end,
          nullif(p->>'hours', '')::numeric, nullif(p->>'days', '')::integer, (p->>'event_date')::date, v_parts, auth.uid(),
          (select m.full_name from public.opd_appt_members m where m.user_id = auth.uid()))
  returning id into v_id;
  return v_id;
end $fn$;

-- طلباتي: صاحب الطلب يرى حالة طلباته فقط (بدون نقاط)
create or replace function public.opd_perf_my_contribs()
returns table(id uuid, ctype text, title text, event_date date, status text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.opd_perf_is_member() then raise exception 'Not authorized'; end if;
  return query select c.id, c.ctype, c.title, c.event_date, c.status, c.created_at
    from public.opd_perf_contrib c where c.submitted_by = auth.uid() order by c.created_at desc limit 100;
end $fn$;

-- بيانات لوحة التقييم: للمدير فقط
create or replace function public.opd_perf_admin_data(p_year integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare v_from date; v_to date;
begin
  if not public.opd_kpi_is_admin() then raise exception 'Not authorized'; end if;
  v_from := make_date(p_year - 1, 12, 1);
  v_to := make_date(p_year, 11, 30);
  return jsonb_build_object(
    'from', v_from, 'to', v_to,
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'empno', t.employee_no, 'supervisor', t.perf_supervisor) order by t.name)
                       from public.opd_team t where t.active), '[]'::jsonb),
    'reports', coalesce((select jsonb_agg(to_jsonb(r) order by r.report_date) from public.opd_perf_reports r
                         where r.report_date between v_from and v_to), '[]'::jsonb),
    'contribs', coalesce((select jsonb_agg(to_jsonb(c) order by c.event_date) from public.opd_perf_contrib c
                          where c.event_date between v_from and v_to or c.status = 'pending'), '[]'::jsonb),
    'leaves', coalesce((select jsonb_agg(jsonb_build_object('staff_id', l.staff_id, 'start', l.start_date, 'end', l.end_date))
                        from public.opd_team_leaves l where l.status = 'approved' and l.end_date >= v_from and l.start_date <= v_to), '[]'::jsonb),
    'charter', coalesce((select jsonb_agg(jsonb_build_object('staff_id', h.staff_id, 'accepted_on', h.accepted_on))
                         from public.opd_perf_charter h where h.year = p_year), '[]'::jsonb));
end $fn$;

create or replace function public.opd_perf_contrib_decide(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  if not public.opd_kpi_is_admin() then raise exception 'Not authorized'; end if;
  if p_status not in ('approved', 'rejected', 'pending') then raise exception 'حالة غير صحيحة'; end if;
  update public.opd_perf_contrib set status = p_status, decided_at = case when p_status = 'pending' then null else now() end where id = p_id;
end $fn$;

create or replace function public.opd_perf_report_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  if not public.opd_kpi_is_admin() then raise exception 'Not authorized'; end if;
  delete from public.opd_perf_reports where id = p_id;
end $fn$;

create or replace function public.opd_perf_set_supervisor(p_staff uuid, p_flag boolean)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  if not public.opd_kpi_is_admin() then raise exception 'Not authorized'; end if;
  update public.opd_team set perf_supervisor = coalesce(p_flag, false) where id = p_staff;
end $fn$;

create or replace function public.opd_perf_charter_set(p_staff uuid, p_year integer, p_on date)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  if not public.opd_kpi_is_admin() then raise exception 'Not authorized'; end if;
  if p_on is null then
    delete from public.opd_perf_charter where staff_id = p_staff and year = p_year;
  else
    insert into public.opd_perf_charter(staff_id, year, accepted_on) values (p_staff, p_year, p_on)
    on conflict (staff_id, year) do update set accepted_on = excluded.accepted_on;
  end if;
end $fn$;

do $$
declare f text;
begin
  foreach f in array array['opd_perf_is_member()', 'opd_perf_staff_list()', 'opd_perf_report_submit(uuid,text,date,text[],text)',
    'opd_perf_contrib_submit(jsonb)', 'opd_perf_my_contribs()', 'opd_perf_admin_data(integer)', 'opd_perf_contrib_decide(uuid,text)',
    'opd_perf_report_delete(uuid)', 'opd_perf_set_supervisor(uuid,boolean)', 'opd_perf_charter_set(uuid,integer,date)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;
