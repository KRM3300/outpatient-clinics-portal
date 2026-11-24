-- طلبات الحجز الموحّدة — 2026-11-24
-- المشكلة: قيدان (NOT VALID) يتحققان من «الطبيب» و«هوية المراجع» عند أي تعديل على الصف،
-- فالطلبات المنقولة من نموذج المستشفيات التابعة (بدون طبيب/تاريخ ميلاد) ما يمكن حفظ حالتها أبداً.
-- الحل: نفس الشروط بالضبط تبقى على الطلبات الجديدة فقط (عند الإدخال)، ولا تمنع معالجة الطلبات القائمة.
-- للتراجع: احذف الـtrigger وأعد إنشاء القيدين بتعريفهما الأصلي أدناه مع NOT VALID.
--   opd_booking_doctor_required: CHECK ((kind <> ALL (ARRAY['affiliate','low_back'])) OR (NULLIF(btrim(COALESCE(doctor_name,'')),'') IS NOT NULL))
--   opd_booking_patient_identity_required: CHECK ((kind <> ALL (ARRAY['affiliate','phc_triage'])) OR ((COALESCE(patient_identifier,'') ~ '^[12][0-9]{9}$') AND (patient_dob IS NOT NULL) AND (array_length(regexp_split_to_array(btrim(COALESCE(patient_name,'')),'\s+'),1) >= 4)))

create or replace function public.opd_booking_insert_checks()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  -- النقل من الشيت يتم عبر دالة موثوقة (ليست حساب موظف) فلا تُطبّق عليه شروط النموذج
  if current_user not in ('authenticated','anon') then return new; end if;
  if new.kind in ('affiliate','low_back')
     and nullif(btrim(coalesce(new.doctor_name,'')),'') is null then
    raise exception using errcode = '23514', message = 'new row for relation "opd_appt_requests" violates check constraint "opd_booking_doctor_required"';
  end if;
  if new.kind in ('affiliate','phc_triage') and not (
       coalesce(new.patient_identifier,'') ~ '^[12][0-9]{9}$'
       and new.patient_dob is not null
       and array_length(regexp_split_to_array(btrim(coalesce(new.patient_name,'')),'\s+'),1) >= 4) then
    raise exception using errcode = '23514', message = 'new row for relation "opd_appt_requests" violates check constraint "opd_booking_patient_identity_required"';
  end if;
  return new;
end
$function$;

drop trigger if exists opd_booking_insert_checks_trigger on public.opd_appt_requests;
create trigger opd_booking_insert_checks_trigger
  before insert on public.opd_appt_requests
  for each row execute function public.opd_booking_insert_checks();

alter table public.opd_appt_requests drop constraint if exists opd_booking_doctor_required;
alter table public.opd_appt_requests drop constraint if exists opd_booking_patient_identity_required;
