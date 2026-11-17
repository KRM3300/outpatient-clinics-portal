-- جدول أطباء العيادات: من شيت OPD Schedule إلى Supabase عبر سكربت جوجل اليومي (2026-11-18)
-- إضافة فقط وقابل لإعادة التشغيل. يستخدم نفس السر drive_sync في opd_sync_secrets.
-- الدليل وصفحة جدول العيادات يقرآن opd_clinic_schedule_get()، والجدول المضمّن في الدليل يبقى احتياطاً.

create table if not exists public.opd_clinic_schedule (
  id integer primary key default 1 check (id = 1),
  week_start date not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.opd_clinic_schedule enable row level security;
revoke all on table public.opd_clinic_schedule from public, anon, authenticated;

create or replace function public.opd_schedule_ingest(p_secret text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_expected text;
  v_week jsonb;
  v_rows jsonb;
  v_x jsonb;
  v_n integer;
  v_leaves integer := 0;
  v_day integer;
  v_err text;
begin
  select s.secret into v_expected from public.opd_sync_secrets s where s.name = 'drive_sync';
  if v_expected is null or p_secret is null or p_secret is distinct from v_expected then
    insert into public.opd_sync_runs(source, ok, message)
    values ('clinic_schedule', false, 'رفض محاولة تحديث الجدول: مفتاح غير صحيح');
    return jsonb_build_object('ok', false, 'error', 'invalid_secret');
  end if;

  if p_payload->>'type' = 'error_report' then
    insert into public.opd_sync_runs(source, ok, message)
    values ('clinic_schedule', false, left(coalesce(nullif(p_payload->>'message', ''), 'تعذر قراءة الجدول الأسبوعي'), 250));
    return jsonb_build_object('ok', true, 'logged', true);
  end if;

  begin
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 1500000 then
      raise exception 'Invalid payload';
    end if;
    v_week := p_payload->'WEEK';
    v_rows := p_payload->'SCH_DATA';
    if jsonb_typeof(v_week) <> 'array' or jsonb_array_length(v_week) <> 5 then
      raise exception 'WEEK must contain 5 dates';
    end if;
    for v_x in select value from jsonb_array_elements(v_week) loop
      if (v_x #>> '{}') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then raise exception 'Invalid WEEK date'; end if;
    end loop;
    if jsonb_typeof(v_rows) <> 'array' then raise exception 'SCH_DATA must be an array'; end if;
    v_n := jsonb_array_length(v_rows);
    if v_n < 50 or v_n > 3000 then raise exception 'SCH_DATA size out of range: %', v_n; end if;
    for v_x in select value from jsonb_array_elements(v_rows) loop
      if jsonb_typeof(v_x) <> 'object'
         or nullif(btrim(v_x->>'name'), '') is null or length(v_x->>'name') > 120
         or nullif(btrim(v_x->>'clinic'), '') is null or length(v_x->>'clinic') > 120
         or length(coalesce(v_x->>'room', '')) > 20
         or (v_x->>'day') !~ '^[0-4]$' or (v_x->>'period') !~ '^[0-2]$'
         or jsonb_typeof(v_x->'leave') <> 'boolean'
         or length(coalesce(v_x->>'fullName', '')) > 180
         or length(coalesce(v_x->>'leaveStart', '')) > 20
         or length(coalesce(v_x->>'leaveEnd', '')) > 20 then
        raise exception 'Invalid schedule row';
      end if;
      v_day := (v_x->>'day')::integer;
      if (v_x->>'date') is distinct from (v_week->>v_day) then raise exception 'Row date does not match WEEK'; end if;
      if (v_x->>'leave')::boolean then v_leaves := v_leaves + 1; end if;
    end loop;

    insert into public.opd_clinic_schedule(id, week_start, data, updated_at)
    values (1, (v_week->>0)::date, jsonb_build_object('WEEK', v_week, 'SCH_DATA', v_rows), now())
    on conflict (id) do update set week_start = excluded.week_start, data = excluded.data, updated_at = now();

    insert into public.opd_sync_runs(source, ok, message)
    values ('clinic_schedule', true, 'جدول العيادات: ' || v_n || ' فترة، منها ' || v_leaves || ' إجازة — أسبوع ' || (v_week->>0));
    return jsonb_build_object('ok', true, 'slots', v_n, 'leaves', v_leaves, 'week', v_week->>0);
  exception when others then
    v_err := left(sqlerrm, 180);
    insert into public.opd_sync_runs(source, ok, message)
    values ('clinic_schedule', false, 'فشل تحديث جدول العيادات: ' || v_err);
    return jsonb_build_object('ok', false, 'error', 'schedule_failed', 'message', v_err);
  end;
end;
$fn$;
revoke all on function public.opd_schedule_ingest(text, jsonb) from public, anon, authenticated;
grant execute on function public.opd_schedule_ingest(text, jsonb) to anon;

-- قراءة عامة (صفحة جدول العيادات عامة): أسماء الأطباء والعيادات والغرف فقط
create or replace function public.opd_clinic_schedule_get()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select c.data || jsonb_build_object('updated_at', c.updated_at)
  from public.opd_clinic_schedule c where c.id = 1;
$fn$;
revoke all on function public.opd_clinic_schedule_get() from public;
grant execute on function public.opd_clinic_schedule_get() to anon, authenticated;

-- حالة المزامنة: نفس الدالة السابقة مع إضافة مصدر clinic_schedule
create or replace function public.opd_sync_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare v_result jsonb;
begin
  if (select auth.uid()) is null or not public.opd_kpi_is_admin() then
    raise exception 'Not authorized';
  end if;
  select jsonb_object_agg(src.source, jsonb_build_object(
    'last_success', (select max(x.created_at) from public.opd_sync_runs x where x.source = src.source and x.ok = true),
    'last_error', (select max(x.created_at) from public.opd_sync_runs x where x.source = src.source and x.ok = false),
    'last_error_message', (select x.message from public.opd_sync_runs x where x.source = src.source and x.ok = false order by x.created_at desc, x.id desc limit 1),
    'last_run', (select x.created_at from public.opd_sync_runs x where x.source = src.source order by x.created_at desc, x.id desc limit 1),
    'last_ok', (select x.ok from public.opd_sync_runs x where x.source = src.source order by x.created_at desc, x.id desc limit 1)
  )) into v_result
  from (values ('drive_kpi'), ('vida_doctors'), ('drive_sync'), ('clinic_schedule')) as src(source);
  return coalesce(v_result, '{}'::jsonb);
end;
$fn$;
revoke all on function public.opd_sync_status() from public, anon, authenticated;
grant execute on function public.opd_sync_status() to authenticated;
