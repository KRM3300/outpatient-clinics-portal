-- ربط شيت «حجز مواعيد للمستشفيات التابعة» بطلبات الحجز الموحّدة — 2026-11-24
-- سكربت OPD Drive Sync (ملف Affiliate.gs) يرسل كل رد جديد من النموذج إلى هذه الدالة بسر خاص به.
-- السر يُولَّد داخل السكربت ويُسجَّل مرة واحدة عبر opd_booking_ingest_register — لا يُكتب في أي ملف.
-- إضافة فقط: لا تغيير في الجداول أو الصلاحيات القائمة.

create or replace function public.opd_booking_ingest_register(p_secret text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_secret is null or length(p_secret) < 32 then raise exception 'weak secret'; end if;
  if exists (select 1 from public.opd_sync_secrets where name = 'affiliate_sync') then
    return false; -- مسجّل مسبقاً؛ لا يُستبدل من الخارج
  end if;
  insert into public.opd_sync_secrets(name, secret) values ('affiliate_sync', p_secret);
  return true;
end
$function$;

create or replace function public.opd_booking_ingest(p_secret text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_expected text;
  r jsonb;
  v_ts timestamptz;
  v_added int := 0;
  v_skipped int := 0;
begin
  select secret into v_expected from public.opd_sync_secrets where name = 'affiliate_sync';
  if v_expected is null or p_secret is distinct from v_expected then
    return jsonb_build_object('ok', false, 'error', 'invalid_secret');
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    return jsonb_build_object('ok', false, 'error', 'bad_payload');
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_ts := (r->>'ts')::timestamptz;
    -- الطلبات قبل 16 نوفمبر 2026 محفوظة كسجل تاريخي (opd_booking_history) ولا تُنقل كطلبات مفتوحة
    if v_ts < timestamptz '2026-11-15 21:00+00' then v_skipped := v_skipped + 1; continue; end if;
    if v_ts is null or nullif(btrim(coalesce(r->>'patient_identifier','')),'') is null
       or length(btrim(coalesce(r->>'patient_name',''))) < 3 then
      v_skipped := v_skipped + 1; continue;
    end if;
    -- منع التكرار: نفس المراجع ونفس وقت الطلب من نفس المصدر
    if exists (select 1 from public.opd_appt_requests q
               where q.external_source = 'affiliate_google_form'
                 and q.patient_identifier = btrim(r->>'patient_identifier')
                 and abs(extract(epoch from q.created_at - v_ts)) < 2) then
      v_skipped := v_skipped + 1; continue;
    end if;

    insert into public.opd_appt_requests(
      kind, patient_name, patient_identifier, patient_dob, mother_name, patient_mobile,
      source_facility, clinic_name, referring_doctor, requester_name, diagnosis_reason,
      manual_fields, status, notification_status, created_at, updated_at,
      external_source, external_row)
    values (
      'affiliate',
      left(btrim(r->>'patient_name'), 120),
      left(btrim(r->>'patient_identifier'), 30),
      nullif(r->>'patient_dob','')::date,
      nullif(left(btrim(coalesce(r->>'mother_name','')), 120), ''),
      nullif(left(btrim(coalesce(r->>'patient_mobile','')), 20), ''),
      nullif(left(btrim(coalesce(r->>'source_facility','')), 120), ''),
      left(btrim(coalesce(nullif(r->>'clinic_name',''), 'غير محددة')), 120),
      nullif(left(btrim(coalesce(r->>'referring_doctor','')), 120), ''),
      nullif(left(btrim(coalesce(r->>'referring_doctor','')), 120), ''),
      'طلب موعد من المستشفيات التابعة (نموذج Google)',
      case when (r->>'clinic_manual')::boolean then array['clinic'] else null end,
      'pending', 'not_sent', v_ts, now(),
      'affiliate_google_form', (extract(epoch from v_ts))::int);
    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('ok', true, 'added', v_added, 'skipped', v_skipped);
end
$function$;

revoke all on function public.opd_booking_ingest_register(text) from public;
revoke all on function public.opd_booking_ingest(text, jsonb) from public;
grant execute on function public.opd_booking_ingest_register(text) to anon, authenticated;
grant execute on function public.opd_booking_ingest(text, jsonb) to anon, authenticated;
