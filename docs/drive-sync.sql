-- Drive → Supabase sync (install manually in Supabase SQL Editor).
-- ADDITIVE ONLY: new objects; no changes to existing tables, policies, or functions.
-- Do not commit real secrets. After running this file, set 'drive_sync' by hand
-- using Supabase SQL Editor:
-- INSERT INTO public.opd_sync_secrets(name,secret) VALUES('drive_sync','<your-long-random-secret>');
-- Use a distinct, high-entropy value in Apps Script PropertiesService SYNC_SECRET.
-- The public sb_publishable_ key is NOT the SYNC_SECRET.
BEGIN;

CREATE TABLE IF NOT EXISTS public.opd_sync_secrets (
  name text PRIMARY KEY,
  secret text NOT NULL
);
ALTER TABLE public.opd_sync_secrets ENABLE ROW LEVEL SECURITY;
-- No RLS policy on purpose. Only the SECURITY DEFINER RPC may read it.
REVOKE ALL ON TABLE public.opd_sync_secrets FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.opd_sync_runs (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  ok boolean NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.opd_sync_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.opd_sync_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.opd_sync_runs TO authenticated;
CREATE POLICY opd_sync_runs_admin_read ON public.opd_sync_runs
  FOR SELECT TO authenticated USING (public.opd_kpi_is_admin());

CREATE TABLE IF NOT EXISTS public.opd_vida_doctors (
  clinic text NOT NULL,
  full_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic, full_name)
);
ALTER TABLE public.opd_vida_doctors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.opd_vida_doctors FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.opd_vida_doctors TO authenticated;
CREATE POLICY opd_vida_doctors_authenticated_read ON public.opd_vida_doctors
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) IS NOT NULL);

-- The only write entrypoint for the Apps Script is this secret-authenticated RPC.
-- It RETURNS {"ok":false} on bad credentials/errors, rather than RAISEing:
-- a raised SQL exception would roll back its failure audit entry.
CREATE OR REPLACE FUNCTION public.opd_drive_ingest(p_secret text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_expected text;
  v_admin uuid;
  v_reports jsonb := '[]'::jsonb;
  v_req jsonb;
  v_day jsonb;
  v_sat jsonb;
  v_sch jsonb;
  v_doctor jsonb;
  v_rec jsonb;
  v_days jsonb;
  v_reasons jsonb;
  v_metrics jsonb;
  v_rs jsonb;
  v_names text[];
  v_mo text;
  v_week date;
  v_start date;
  v_finish date;
  v_title text;
  v_kind text;
  v_i integer;
  v_d integer;
  v_count integer := 0;
  v_changed integer := 0;
  v_doctors_count integer := 0;
  v_record_count integer := 0;
  v_duplicate_count integer;
  v_err text;
  v_source text;
  v_doctor_rows integer;
BEGIN
  SELECT s.secret INTO v_expected
  FROM public.opd_sync_secrets AS s WHERE s.name='drive_sync';
  IF v_expected IS NULL OR p_secret IS NULL OR p_secret IS DISTINCT FROM v_expected THEN
    INSERT INTO public.opd_sync_runs(source,ok,message)
    VALUES('drive_sync',false,'رفض محاولة مزامنة: مفتاح غير صحيح أو لم تتم تهيئة المفتاح');
    RETURN jsonb_build_object('ok',false,'error','invalid_secret');
  END IF;

  -- A best-effort failure marker for network/retrieval errors in Apps Script.
  -- Only whitelisted sources and short operational strings; never raw sheet rows.
  IF p_payload->>'type' = 'error_report' THEN
    v_source := CASE WHEN p_payload->>'source' IN ('drive_kpi','vida_doctors')
                     THEN p_payload->>'source' ELSE 'drive_sync' END;
    INSERT INTO public.opd_sync_runs(source,ok,message)
    VALUES (v_source,false,
      left(coalesce(nullif(p_payload->>'message',''),'تعذر جلب بيانات Google Sheets'),250));
    RETURN jsonb_build_object('ok',true,'logged',true);
  END IF;

  -- All data mutations in this sub-block roll back together on any error.
  BEGIN
    IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
       OR length(p_payload::text)>750000
       OR jsonb_typeof(p_payload->'req')<>'array'
       OR jsonb_typeof(p_payload->'RS')<>'array'
       OR jsonb_typeof(p_payload->'sat')<>'array'
       OR jsonb_typeof(p_payload->'sch')<>'object'
       OR jsonb_typeof(p_payload->'doctors')<>'array' THEN
      RAISE EXCEPTION 'Invalid payload structure';
    END IF;
    IF jsonb_array_length(p_payload->'req')>240
       OR jsonb_array_length(p_payload->'sat')>240
       OR jsonb_array_length(p_payload->'RS')>150
       OR jsonb_array_length(p_payload->'doctors') NOT BETWEEN 1 AND 2500 THEN
      RAISE EXCEPTION 'Payload size or doctors count is invalid';
    END IF;
    SELECT m.user_id INTO v_admin FROM public.opd_appt_members AS m
    WHERE m.role='admin' AND m.status='approved' ORDER BY m.user_id LIMIT 1;
    IF v_admin IS NULL THEN RAISE EXCEPTION 'Approved admin account not found'; END IF;

    -- 1. Requests: exact window.kpiSync summary schema: kind, days, reasons, items.
    FOR v_req IN SELECT value FROM jsonb_array_elements(p_payload->'req') LOOP
      v_mo := v_req->>'mo';
      IF v_mo IS NULL OR v_mo !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'
         OR jsonb_typeof(v_req->'days')<>'array'
         OR jsonb_typeof(v_req->'r')<>'array'
         OR jsonb_array_length(v_req->'r')<>jsonb_array_length(p_payload->'RS')
         OR jsonb_array_length(v_req->'days')>31 THEN
        RAISE EXCEPTION 'Invalid appointment summary';
      END IF;
      v_days := '[]'::jsonb;
      FOR v_day IN SELECT value FROM jsonb_array_elements(v_req->'days') LOOP
        IF jsonb_typeof(v_day)<>'array' OR jsonb_array_length(v_day)<>4
           OR (v_day->>0) !~ '^[0-9]{1,2}$'
           OR (v_day->>1) !~ '^[0-9]{1,8}$'
           OR (v_day->>2) !~ '^[0-9]{1,8}$'
           OR (v_day->>3) !~ '^[0-9]{1,8}$' THEN
          RAISE EXCEPTION 'Invalid daily appointment totals';
        END IF;
        v_d := (v_day->>0)::integer;
        IF v_d NOT BETWEEN 1 AND 31 THEN RAISE EXCEPTION 'Invalid day'; END IF;
        v_start := (v_mo||'-01')::date;
        IF v_d > EXTRACT(day FROM (date_trunc('month',v_start)::date + INTERVAL '1 month - 1 day')) THEN
          RAISE EXCEPTION 'Day outside month';
        END IF;
        v_days := v_days || jsonb_build_array(jsonb_build_object(
          'd',v_mo||'-'||lpad(v_d::text,2,'0'),
          'renew',(v_day->>1)::integer,
          'modify',(v_day->>2)::integer,
          'cancel',(v_day->>3)::integer
        ));
      END LOOP;
      v_reasons := '{}'::jsonb;
      FOR v_i IN 0..(jsonb_array_length(p_payload->'RS')-1) LOOP
        IF length(p_payload->'RS'->>v_i)>140 THEN RAISE EXCEPTION 'Reason label is too long'; END IF;
        IF (v_req->'r'->>v_i) !~ '^[0-9]{1,8}$' THEN
          RAISE EXCEPTION 'Invalid reason total';
        END IF;
        IF (v_req->'r'->>v_i)::integer>0 THEN
          v_reasons := v_reasons || jsonb_build_object(
            p_payload->'RS'->>v_i,(v_req->'r'->>v_i)::integer);
        END IF;
      END LOOP;
      v_start := (v_mo||'-01')::date;
      v_finish := (date_trunc('month',v_start)::date+INTERVAL '1 month - 1 day')::date;
      v_reports := v_reports || jsonb_build_array(jsonb_build_object(
        'kind','requests','title','طلبات المواعيد — '||v_mo,
        'period_from',v_start,'period_to',v_finish,
        'summary',jsonb_build_object('kind','requests','days',v_days,'reasons',v_reasons,'items','[]'::jsonb)
      ));
    END LOOP;

    -- 2. Satisfaction: copy numerical metrics from sheets-agg.js (no patient data).
    v_names := ARRAY[
      'n','reception_n','reception_sum','reception_top',
      'nursing_n','nursing_sum','nursing_top',
      'doctor_n','doctor_sum','doctor_top',
      'pharmacy_n','pharmacy_sum','pharmacy_top',
      'facility_n','facility_sum','facility_top'
    ];
    FOR v_sat IN SELECT value FROM jsonb_array_elements(p_payload->'sat') LOOP
      v_mo := v_sat->>'mo';
      IF v_mo IS NULL OR v_mo !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' THEN
        RAISE EXCEPTION 'Invalid satisfaction month';
      END IF;
      v_metrics := '{}'::jsonb;
      FOR v_i IN 1..array_length(v_names,1) LOOP
        IF v_sat ? v_names[v_i] THEN
          IF (v_sat->>v_names[v_i]) !~ '^[0-9]{1,8}$' THEN
            RAISE EXCEPTION 'Invalid satisfaction metric';
          END IF;
          v_metrics := v_metrics || jsonb_build_object(v_names[v_i],(v_sat->>v_names[v_i])::integer);
        END IF;
      END LOOP;
      v_start := (v_mo||'-01')::date;
      v_finish := (date_trunc('month',v_start)::date+INTERVAL '1 month - 1 day')::date;
      v_reports := v_reports || jsonb_build_array(jsonb_build_object(
        'kind','satisfaction','title','رضا المرضى — '||v_mo,
        'period_from',v_start,'period_to',v_finish,
        'summary',jsonb_build_object('kind','satisfaction','metrics',v_metrics,'items','[]'::jsonb)
      ));
    END LOOP;

    -- 3. Weekly schedule: the same fields and inclusive 5-day (Sun-Thu) period.
    v_sch := p_payload->'sch';
    IF jsonb_typeof(v_sch->'week')<>'string' OR
       (v_sch->>'week') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'Invalid schedule week';
    END IF;
    v_week := (v_sch->>'week')::date;
    v_metrics := '{}'::jsonb;
    FOREACH v_source IN ARRAY ARRAY['used','avail','rooms','slots','slots_new','slots_fu'] LOOP
      IF (v_sch->>v_source) !~ '^[0-9]{1,8}$' THEN
        RAISE EXCEPTION 'Invalid weekly metric';
      END IF;
      v_metrics := v_metrics || jsonb_build_object(v_source,(v_sch->>v_source)::integer);
    END LOOP;
    IF jsonb_typeof(v_sch->'sessions')<>'array'
       OR jsonb_array_length(v_sch->'sessions')>20 THEN
      RAISE EXCEPTION 'Invalid schedule sessions';
    END IF;
    FOR v_rec IN SELECT value FROM jsonb_array_elements(v_sch->'sessions') LOOP
      IF (v_rec#>>'{}') !~ '^[0-9]{1,8}$' THEN
        RAISE EXCEPTION 'Invalid session total';
      END IF;
    END LOOP;
    v_metrics := v_metrics || jsonb_build_object('sessions',v_sch->'sessions');
    v_reports := v_reports || jsonb_build_array(jsonb_build_object(
      'kind','schedule','title','إشغال غرف العيادات — أسبوع '||v_sch->>'week',
      'period_from',v_week,'period_to',v_week+4,
      'summary',jsonb_build_object('kind','schedule','metrics',v_metrics,'items','[]'::jsonb)
    ));

    -- Detect repeated kind+period within the SAME payload before modifying data.
    SELECT count(*) - count(DISTINCT (x->>'kind',x->>'period_from'))
      INTO v_duplicate_count
    FROM jsonb_array_elements(v_reports) AS x;
    IF v_duplicate_count<>0 THEN RAISE EXCEPTION 'Duplicate KPI kind and period'; END IF;

    FOR v_rec IN SELECT value FROM jsonb_array_elements(v_reports) LOOP
      v_kind := v_rec->>'kind';
      v_start := (v_rec->>'period_from')::date;
      v_finish := (v_rec->>'period_to')::date;
      v_count := v_count+1;
      SELECT count(*),count(*) FILTER (WHERE r.summary=(v_rec->'summary'))
        INTO v_record_count,v_duplicate_count
      FROM public.opd_kpi_reports AS r
      WHERE r.report_type='other'
        AND r.summary->>'kind'=v_kind
        AND r.period_from=v_start;
      IF v_record_count=1 AND v_duplicate_count=1 THEN CONTINUE; END IF;

      -- Replace only exact same source kind + starting period. Do not touch
      -- manual KPI reports or any other source.
      DELETE FROM public.opd_kpi_reports AS r
        WHERE r.report_type='other'
          AND r.summary->>'kind'=v_kind
          AND r.period_from=v_start;
      INSERT INTO public.opd_kpi_reports
        (report_type,title,period_from,period_to,summary,file_path,uploaded_by)
      VALUES ('other',v_rec->>'title',v_start,v_finish,v_rec->'summary','',v_admin);
      v_changed := v_changed+1;
    END LOOP;

    -- Replace the complete doctors roster, only after validating a nonempty set.
    -- Staff names are organizational information; patient records are never read.
    FOR v_doctor IN SELECT value FROM jsonb_array_elements(p_payload->'doctors') LOOP
      IF jsonb_typeof(v_doctor)<>'object'
         OR nullif(btrim(v_doctor->>'clinic'),'') IS NULL
         OR nullif(btrim(v_doctor->>'full_name'),'') IS NULL
         OR length(v_doctor->>'clinic')>120 OR length(v_doctor->>'full_name')>180 THEN
        RAISE EXCEPTION 'Invalid VIDA roster row';
      END IF;
    END LOOP;
    DELETE FROM public.opd_vida_doctors;
    INSERT INTO public.opd_vida_doctors(clinic,full_name,updated_at)
    SELECT DISTINCT btrim(x->>'clinic'),btrim(x->>'full_name'),now()
    FROM jsonb_array_elements(p_payload->'doctors') AS x;
    GET DIAGNOSTICS v_doctors_count=ROW_COUNT;

    INSERT INTO public.opd_sync_runs(source,ok,message)
    VALUES ('drive_kpi',true,'تقارير المؤشرات: '||v_count||'، تم تحديث '||v_changed),
           ('vida_doctors',true,'أطباء VIDA: '||v_doctors_count);
    RETURN jsonb_build_object('ok',true,'reports',v_count,
      'updated_reports',v_changed,'doctors',v_doctors_count);

  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM,180);
    INSERT INTO public.opd_sync_runs(source,ok,message)
    VALUES ('drive_kpi',false,'فشل مزامنة Drive: '||v_err),
           ('vida_doctors',false,'فشل التحديث المشترك: '||v_err);
    RETURN jsonb_build_object('ok',false,'error','sync_failed','message',v_err);
  END;
END;
$fn$;

REVOKE ALL ON FUNCTION public.opd_drive_ingest(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.opd_drive_ingest(text,jsonb) TO anon;

CREATE OR REPLACE FUNCTION public.opd_sync_status()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT public.opd_kpi_is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT jsonb_object_agg(src.source,jsonb_build_object(
    'last_success',(SELECT max(x.created_at) FROM public.opd_sync_runs AS x
      WHERE x.source=src.source AND x.ok=true),
    'last_error',(SELECT max(x.created_at) FROM public.opd_sync_runs AS x
      WHERE x.source=src.source AND x.ok=false),
    'last_error_message',(SELECT x.message FROM public.opd_sync_runs AS x
      WHERE x.source=src.source AND x.ok=false ORDER BY x.created_at DESC,x.id DESC LIMIT 1),
    'last_run',(SELECT x.created_at FROM public.opd_sync_runs AS x
      WHERE x.source=src.source ORDER BY x.created_at DESC,x.id DESC LIMIT 1),
    'last_ok',(SELECT x.ok FROM public.opd_sync_runs AS x
      WHERE x.source=src.source ORDER BY x.created_at DESC,x.id DESC LIMIT 1)
  )) INTO v_result
  FROM (VALUES ('drive_kpi'),('vida_doctors'),('drive_sync')) AS src(source);
  RETURN coalesce(v_result,'{}'::jsonb);
END;
$fn$;
REVOKE ALL ON FUNCTION public.opd_sync_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.opd_sync_status() TO authenticated;

COMMIT;
