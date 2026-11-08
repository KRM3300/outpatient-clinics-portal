-- منصة الأداء والمؤشرات — إعداد Supabase (يُشغَّل مرة واحدة في SQL Editor)
-- يعتمد على جدول opd_appt_members الموجود (مدير النظام = role 'admin' و status 'approved').
-- لا يحتوي بيانات مرضى: المنصة للمؤشرات المجمّعة فقط.

-- 1) من يحق له المشاهدة
create table if not exists public.opd_kpi_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  active boolean not null default true,
  granted_at timestamptz not null default now()
);

create or replace function public.opd_kpi_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.opd_appt_members
                 where user_id = auth.uid() and role = 'admin' and status = 'approved');
$$;

create or replace function public.opd_kpi_can_view() returns boolean
language sql stable security definer set search_path = public as $$
  select public.opd_kpi_is_admin()
      or exists (select 1 from public.opd_kpi_access where user_id = auth.uid() and active);
$$;

-- 2) سجل التقارير
create table if not exists public.opd_kpi_reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null check (report_type in
    ('referrals_daily','reverse_daily','reverse_weekly','adaa_weekly','no_show','other')),
  title text not null check (char_length(title) between 3 and 200),
  period_from date not null,
  period_to date not null check (period_to >= period_from),
  summary jsonb not null default '{}'::jsonb,
  file_path text not null,
  uploaded_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists opd_kpi_reports_type_date on public.opd_kpi_reports (report_type, period_to desc);

alter table public.opd_kpi_access enable row level security;
alter table public.opd_kpi_reports enable row level security;

drop policy if exists kpi_reports_read on public.opd_kpi_reports;
create policy kpi_reports_read on public.opd_kpi_reports for select to authenticated using (public.opd_kpi_can_view());
drop policy if exists kpi_reports_write on public.opd_kpi_reports;
create policy kpi_reports_write on public.opd_kpi_reports for insert to authenticated
  with check (public.opd_kpi_is_admin() and uploaded_by = auth.uid());
drop policy if exists kpi_reports_delete on public.opd_kpi_reports;
create policy kpi_reports_delete on public.opd_kpi_reports for delete to authenticated using (public.opd_kpi_is_admin());

drop policy if exists kpi_access_self on public.opd_kpi_access;
create policy kpi_access_self on public.opd_kpi_access for select to authenticated
  using (user_id = auth.uid() or public.opd_kpi_is_admin());
drop policy if exists kpi_access_admin on public.opd_kpi_access;
create policy kpi_access_admin on public.opd_kpi_access for all to authenticated
  using (public.opd_kpi_is_admin()) with check (public.opd_kpi_is_admin());

-- 3) منح الصلاحية بالبريد (المستخدم لازم يكون سجّل دخول مرة واحدة على الأقل)
create or replace function public.opd_kpi_grant(p_email text, p_active boolean default true) returns text
language plpgsql security definer set search_path = public, auth as $$
declare v uuid;
begin
  if not public.opd_kpi_is_admin() then raise exception 'not allowed'; end if;
  select id into v from auth.users where lower(email) = lower(trim(p_email));
  if v is null then return 'not_found'; end if;
  insert into public.opd_kpi_access (user_id, email, active) values (v, lower(trim(p_email)), p_active)
  on conflict (user_id) do update set active = excluded.active, email = excluded.email;
  return 'ok';
end $$;
revoke all on function public.opd_kpi_grant(text, boolean) from public, anon;
grant execute on function public.opd_kpi_grant(text, boolean) to authenticated;

-- 4) ملفات PDF — مخزن خاص (غير عام)، 10 ميجا، PDF فقط
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('opd-kpi-reports', 'opd-kpi-reports', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists kpi_files_read on storage.objects;
create policy kpi_files_read on storage.objects for select to authenticated
  using (bucket_id = 'opd-kpi-reports' and public.opd_kpi_can_view());
drop policy if exists kpi_files_write on storage.objects;
create policy kpi_files_write on storage.objects for insert to authenticated
  with check (bucket_id = 'opd-kpi-reports' and public.opd_kpi_is_admin());
drop policy if exists kpi_files_delete on storage.objects;
create policy kpi_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'opd-kpi-reports' and public.opd_kpi_is_admin());

-- 5) صلاحيات الجداول والدوال (المشروع لا يمنحها تلقائياً)
grant select, insert, delete on public.opd_kpi_reports to authenticated;
grant select, insert, update, delete on public.opd_kpi_access to authenticated;
grant execute on function public.opd_kpi_is_admin() to authenticated;
grant execute on function public.opd_kpi_can_view() to authenticated;
