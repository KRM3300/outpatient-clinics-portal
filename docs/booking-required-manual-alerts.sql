-- طلبات الحجز الموحّدة: الحقول الإلزامية + اسم الطبيب + تنبيه الإدخال اليدوي (2026-11-18)
-- إضافة فقط: لا يحذف بيانات، والشروط NOT VALID فتطبّق على الطلبات الجديدة دون السجلات القديمة.

alter table public.opd_appt_requests
  add column if not exists manual_fields text[],
  add column if not exists manual_reviewed_at timestamptz,
  add column if not exists manual_reviewed_by uuid;

do $$ begin
  -- الفرز والمستشفيات التابعة: اسم رباعي + هوية/إقامة 10 أرقام تبدأ بـ1 أو 2 + تاريخ ميلاد
  if not exists (select 1 from pg_constraint where conname = 'opd_booking_patient_identity_required') then
    alter table public.opd_appt_requests add constraint opd_booking_patient_identity_required
      check (kind not in ('affiliate','phc_triage') or (
        coalesce(patient_identifier,'') ~ '^[12][0-9]{9}$'
        and patient_dob is not null
        and array_length(regexp_split_to_array(btrim(coalesce(patient_name,'')), '\s+'), 1) >= 4
      )) not valid;
  end if;
  -- المستشفيات التابعة وأسفل الظهر: اسم الطبيب إلزامي
  if not exists (select 1 from pg_constraint where conname = 'opd_booking_doctor_required') then
    alter table public.opd_appt_requests add constraint opd_booking_doctor_required
      check (kind not in ('affiliate','low_back') or nullif(btrim(coalesce(doctor_name,'')),'') is not null) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'opd_booking_manual_fields_valid') then
    alter table public.opd_appt_requests add constraint opd_booking_manual_fields_valid
      check (manual_fields is null or manual_fields <@ array['facility','clinic','doctor']::text[]) not valid;
  end if;
end $$;

-- مقدّم الطلب لا يقدر يعلّم التنبيه كمراجَع عند الإنشاء
create or replace function public.opd_booking_manual_stamp()
returns trigger language plpgsql set search_path = '' as $f$
begin
  new.manual_reviewed_at := null;
  new.manual_reviewed_by := null;
  if new.manual_fields is not null and cardinality(new.manual_fields) = 0 then new.manual_fields := null; end if;
  return new;
end $f$;
drop trigger if exists opd_booking_manual_stamp_trigger on public.opd_appt_requests;
create trigger opd_booking_manual_stamp_trigger before insert on public.opd_appt_requests
for each row execute function public.opd_booking_manual_stamp();

create index if not exists opd_booking_manual_open
  on public.opd_appt_requests(created_at desc)
  where manual_fields is not null and manual_reviewed_at is null;

-- قائمة التنبيهات للمدير فقط — بدون بيانات المريض
create or replace function public.opd_booking_manual_alerts()
returns table(id uuid, kind text, created_at timestamptz, requester_name text,
              source_facility text, clinic_name text, doctor_name text, manual_fields text[])
language plpgsql stable security definer set search_path = '' as $f$
begin
  if not public.opd_kpi_is_admin() then raise exception 'Not authorized'; end if;
  return query
    select r.id, r.kind, r.created_at, r.requester_name, r.source_facility, r.clinic_name, r.doctor_name, r.manual_fields
    from public.opd_appt_requests r
    where r.manual_fields is not null and r.manual_reviewed_at is null
    order by r.created_at desc limit 200;
end $f$;
revoke all on function public.opd_booking_manual_alerts() from public, anon;
grant execute on function public.opd_booking_manual_alerts() to authenticated;

create or replace function public.opd_booking_manual_review(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $f$
begin
  if not public.opd_kpi_is_admin() then raise exception 'Not authorized'; end if;
  update public.opd_appt_requests set manual_reviewed_at = now(), manual_reviewed_by = auth.uid()
  where id = p_id and manual_fields is not null;
end $f$;
revoke all on function public.opd_booking_manual_review(uuid) from public, anon;
grant execute on function public.opd_booking_manual_review(uuid) to authenticated;
