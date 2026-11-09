-- تقرير عدم الالتزام (حصر المشاكل) — إعداد Supabase (مرة واحدة)
-- الرفع: التمريض والاستقبال وكير لينك المعتمدون + من يمنحه المدير. الاطلاع: المدير + من يمنحه المدير فقط.

create table if not exists public.opd_nc_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  can_submit boolean not null default false,
  can_view boolean not null default false,
  granted_at timestamptz not null default now()
);

create table if not exists public.opd_nc_reports (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  employee_name text not null check (char_length(employee_name) between 2 and 150),
  work_nature text not null,
  specialty text,
  observation_type text not null,
  notes text check (char_length(notes) <= 2000),
  patient_file text check (char_length(patient_file) <= 30),
  reporter_name text not null check (char_length(reporter_name) between 2 and 150),
  reporter_empno text not null check (char_length(reporter_empno) between 2 and 20),
  source text not null default 'app' check (source in ('app', 'google_form')),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists opd_nc_reports_date on public.opd_nc_reports (occurred_at desc);

create or replace function public.opd_nc_can_view() returns boolean
language sql stable security definer set search_path = public as $$
  select public.opd_kpi_is_admin()
      or exists (select 1 from public.opd_nc_access where user_id = auth.uid() and can_view);
$$;

create or replace function public.opd_nc_can_submit() returns boolean
language sql stable security definer set search_path = public as $$
  select public.opd_kpi_is_admin()
      or exists (select 1 from public.opd_nc_access where user_id = auth.uid() and can_submit)
      or exists (select 1 from public.opd_appt_members where user_id = auth.uid() and status = 'approved'
                 and job_title in ('nurse', 'reception', 'carelink'));
$$;

alter table public.opd_nc_access enable row level security;
alter table public.opd_nc_reports enable row level security;

create policy nc_reports_read on public.opd_nc_reports for select to authenticated using (public.opd_nc_can_view());
create policy nc_reports_insert on public.opd_nc_reports for insert to authenticated
  with check (public.opd_nc_can_submit() and created_by = auth.uid() and (source = 'app' or public.opd_kpi_is_admin()));
create policy nc_reports_delete on public.opd_nc_reports for delete to authenticated using (public.opd_kpi_is_admin());
create policy nc_access_self on public.opd_nc_access for select to authenticated using (user_id = auth.uid() or public.opd_kpi_is_admin());

-- منح الصلاحية بالبريد (المستخدم لازم يكون سجّل دخول مرة واحدة)
create or replace function public.opd_nc_grant(p_email text, p_submit boolean, p_view boolean) returns text
language plpgsql security definer set search_path = public, auth as $$
declare v uuid;
begin
  if not public.opd_kpi_is_admin() then raise exception 'not allowed'; end if;
  select id into v from auth.users where lower(email) = lower(trim(p_email));
  if v is null then return 'not_found'; end if;
  insert into public.opd_nc_access (user_id, email, can_submit, can_view) values (v, lower(trim(p_email)), p_submit, p_view)
  on conflict (user_id) do update set can_submit = excluded.can_submit, can_view = excluded.can_view, email = excluded.email;
  return 'ok';
end $$;

revoke all on function public.opd_nc_grant(text, boolean, boolean) from public, anon;
grant execute on function public.opd_nc_grant(text, boolean, boolean) to authenticated;
grant execute on function public.opd_nc_can_view() to authenticated;
grant execute on function public.opd_nc_can_submit() to authenticated;
grant select, insert, delete on public.opd_nc_reports to authenticated;
grant select on public.opd_nc_access to authenticated;
