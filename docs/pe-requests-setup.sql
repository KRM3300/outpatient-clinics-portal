-- تجربة المريض: خانات طلبات المواعيد + وقت الإقفال (للـSLA) + استيراد سجل الشيت
-- إضافات فقط على الجدول الحالي opd_pe_cases

alter table public.opd_pe_cases
  add column if not exists patient_name text check (char_length(patient_name) <= 150),
  add column if not exists patient_file text check (char_length(patient_file) <= 30),
  add column if not exists request_type text check (char_length(request_type) <= 40),
  add column if not exists reason text check (char_length(reason) <= 500),
  add column if not exists solution text check (char_length(solution) <= 500),
  add column if not exists doctor_name text check (char_length(doctor_name) <= 150),
  add column if not exists pe_staff_name text check (char_length(pe_staff_name) <= 150),
  add column if not exists opd_staff_name text check (char_length(opd_staff_name) <= 150),
  add column if not exists closed_at timestamptz,
  add column if not exists source text not null default 'app' check (source in ('app', 'sheet'));

-- نوع حالة جديد: طلب موعد
alter table public.opd_pe_cases drop constraint if exists opd_pe_cases_case_type_check;
alter table public.opd_pe_cases add constraint opd_pe_cases_case_type_check
  check (case_type in ('complaint', 'incident', 'suggestion', 'noncompliance', 'appointment'));

-- عند الإقفال: يُسجَّل وقت الإقفال واسم من أقفل تلقائياً
create or replace function public.opd_pe_on_close() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    new.closed_at := coalesce(new.closed_at, now());
    if coalesce(new.opd_staff_name, '') = '' then
      select full_name into new.opd_staff_name from public.opd_appt_members where user_id = auth.uid();
    end if;
  elsif new.status <> 'closed' then
    new.closed_at := null;
  end if;
  return new;
end $$;
create or replace trigger trg_pe_on_close before update on public.opd_pe_cases
  for each row execute function public.opd_pe_on_close();

-- استيراد سجل الشيت (للمدير فقط، مرة واحدة)
create or replace function public.opd_pe_import(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.opd_kpi_is_admin() then raise exception 'Not authorized'; end if;
  insert into public.opd_pe_cases (case_type, title, description, department, priority, status, resolution,
      patient_name, patient_file, request_type, reason, solution, doctor_name, pe_staff_name, opd_staff_name,
      created_at, closed_at, created_by, source)
  select 'appointment', left(coalesce(nullif(r->>'title', ''), 'طلب موعد'), 180), r->>'description', 'العيادات الخارجية', 'normal',
         'closed', coalesce(nullif(r->>'resolution', ''), 'تم'),
         r->>'patient_name', r->>'patient_file', r->>'request_type', r->>'reason', r->>'solution', r->>'doctor_name',
         r->>'pe_staff_name', r->>'opd_staff_name',
         (r->>'created_at')::timestamptz, nullif(r->>'closed_at', '')::timestamptz, auth.uid(), 'sheet'
  from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.opd_pe_import(jsonb) from public, anon;
grant execute on function public.opd_pe_import(jsonb) to authenticated;
