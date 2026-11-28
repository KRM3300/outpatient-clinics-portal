-- طلب الإجازة من دليل الموظف بحساب المنصة (28 نوفمبر 2026)
-- إضافات فقط: لا حذف لجداول أو سجلات. هوية الموظف = auth.uid()، والتحقق كله داخل قاعدة البيانات.
-- المسموح: حساب معتمد في المنصة ومصنّف «موظف عيادات خارجية» (opd_appt_members.outpatient_staff).

-- ===== 1) نسخة احتياطية قبل التعديل =====
create table if not exists public.opd_team_bak_20261128 as select * from public.opd_team;
create table if not exists public.opd_team_leaves_bak_20261128 as select * from public.opd_team_leaves;
create table if not exists public.opd_fn_bak_20261128 as
  select p.proname::text as name, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('opd_leave_eligible', 'opd_team_leave_submit', 'opd_team_leave_mine', 'opd_team_names');
alter table public.opd_team_bak_20261128 enable row level security;
alter table public.opd_team_leaves_bak_20261128 enable row level security;
alter table public.opd_fn_bak_20261128 enable row level security;
revoke all on public.opd_team_bak_20261128, public.opd_team_leaves_bak_20261128, public.opd_fn_bak_20261128 from anon, authenticated;

-- ===== 2) ربط سجل جدول الموظفين بحساب المنصة =====
alter table public.opd_team add column if not exists user_id uuid unique references auth.users(id) on delete set null;
alter table public.opd_team add column if not exists auto_created boolean not null default false;

-- ربط آمن للسجلات القديمة: بالرقم الوظيفي المطابق، أو بالاسم «المطابق حرفياً» إذا كان التطابق وحيداً من الطرفين. لا ربط بالتشابه.
update public.opd_team t set user_id = m.user_id
from public.opd_appt_members m
where t.user_id is null and t.employee_no is not null
  and public.opd_team_norm(m.employee_no) = t.employee_no
  and m.status = 'approved' and m.outpatient_staff
  and not exists (select 1 from public.opd_team x where x.user_id = m.user_id);

with c as (
  select t.id as tid, m.user_id, nullif(public.opd_team_norm(m.employee_no), '') as e
  from public.opd_team t
  join public.opd_appt_members m on btrim(m.full_name) = t.name and m.status = 'approved' and m.outpatient_staff
  where t.user_id is null and t.employee_no is null
), u as (
  select * from c
  where tid in (select tid from c group by tid having count(*) = 1)
    and user_id in (select user_id from c group by user_id having count(*) = 1)
    and not exists (select 1 from public.opd_team x where x.user_id = c.user_id)
)
update public.opd_team t
set user_id = u.user_id,
    employee_no = case when u.e is not null and not exists (select 1 from public.opd_team x where x.employee_no = u.e) then u.e else t.employee_no end
from u where t.id = u.tid;

-- ===== 3) سياق الموظف الحالي (داخلي) =====
create or replace function public.opd_leave_member_() returns public.opd_appt_members
language plpgsql stable security definer set search_path = public as $$
declare m public.opd_appt_members;
begin
  if auth.uid() is null then raise exception 'سجّل دخولك في منصة العيادات الخارجية أولاً.'; end if;
  select * into m from public.opd_appt_members where user_id = auth.uid();
  if not found or m.status <> 'approved' then raise exception 'حسابك في المنصة غير معتمد بعد. تواصل مع مدير العيادات الخارجية.'; end if;
  if not m.outpatient_staff then
    raise exception 'تقديم الإجازة من الدليل لموظفي العيادات الخارجية فقط. إذا كنت منهم، تواصل مع مدير العيادات الخارجية لتصنيف حسابك.';
  end if;
  return m;
end $$;

-- سجل الموظف في جدول الفريق: موجود بالحساب، أو بالرقم الوظيفي، أو يُنشأ مرة واحدة (بدون تكرار)
create or replace function public.opd_leave_staff_id_(m public.opd_appt_members) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_owner uuid; v_no text := nullif(public.opd_team_norm(m.employee_no), ''); v_name text := btrim(m.full_name);
begin
  perform pg_advisory_xact_lock(hashtext('opd_leave_link|' || m.user_id::text));
  select id into v_id from public.opd_team where user_id = m.user_id;
  if found then return v_id; end if;
  if v_no is null or length(v_no) < 4 then raise exception 'أكمل رقمك الوظيفي أولاً.'; end if;
  select id, user_id into v_id, v_owner from public.opd_team where employee_no = v_no;
  if found then
    if v_owner is not null and v_owner <> m.user_id then
      raise exception 'رقمك الوظيفي مرتبط بحساب آخر. تواصل مع مدير العيادات الخارجية.';
    end if;
    update public.opd_team set user_id = m.user_id where id = v_id;
    return v_id;
  end if;
  if exists (select 1 from public.opd_team where name = v_name) then v_name := v_name || ' (' || v_no || ')'; end if;
  insert into public.opd_team (name, employee_no, user_id, auto_created) values (v_name, v_no, m.user_id, true) returning id into v_id;
  return v_id;
end $$;

-- ===== 4) دوال الدليل (للمسجّلين فقط) =====
-- بيانات الموظف ورسالة واضحة بدل إخفاء النموذج
create or replace function public.opd_leave_me() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m public.opd_appt_members; v_no text;
begin
  begin
    m := public.opd_leave_member_();
  exception when others then
    return jsonb_build_object('ok', false, 'message', sqlerrm);
  end;
  v_no := nullif(public.opd_team_norm(m.employee_no), '');
  return jsonb_build_object('ok', true, 'name', btrim(m.full_name), 'employee_no', v_no,
    'needs_employee_no', v_no is null or length(v_no) < 4);
end $$;

-- استكمال الرقم الوظيفي مرة واحدة (لا يُغيَّر بعدها إلا من المدير)
create or replace function public.opd_leave_profile_save(p_empno text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.opd_appt_members; v_no text := public.opd_team_norm(p_empno); v_old text;
begin
  m := public.opd_leave_member_();
  if length(v_no) < 4 or length(v_no) > 12 then raise exception 'اكتب رقمك الوظيفي بشكل صحيح.'; end if;
  v_old := nullif(public.opd_team_norm(m.employee_no), '');
  if v_old = v_no then return jsonb_build_object('ok', true); end if;
  if v_old is not null and length(v_old) >= 4 then
    raise exception 'رقمك الوظيفي محفوظ مسبقاً. لتعديله تواصل مع مدير العيادات الخارجية.';
  end if;
  if exists (select 1 from public.opd_appt_members where user_id <> m.user_id and public.opd_team_norm(employee_no) = v_no)
     or exists (select 1 from public.opd_team where employee_no = v_no and user_id is not null and user_id <> m.user_id) then
    raise exception 'الرقم الوظيفي مسجل لحساب آخر. تواصل مع مدير العيادات الخارجية.';
  end if;
  update public.opd_appt_members set employee_no = v_no where user_id = m.user_id;
  return jsonb_build_object('ok', true);
end $$;

-- تقديم الطلب باسم صاحب الحساب فقط
create or replace function public.opd_leave_submit(p_type text, p_from date, p_to date, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.opd_appt_members; v_staff uuid; v_today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  m := public.opd_leave_member_();
  if p_type is null or p_type not in ('اعتيادية', 'مرضية', 'تعويضية') then raise exception 'اختر نوع الإجازة.'; end if;
  if p_from is null or p_to is null then raise exception 'حدد تاريخ البداية والنهاية.'; end if;
  if p_to < p_from then raise exception 'تاريخ النهاية لازم يكون بعد البداية أو نفسها.'; end if;
  if p_from < v_today - 30 then raise exception 'تاريخ البداية قديم جداً.'; end if;
  if p_to - p_from > 120 then raise exception 'مدة الإجازة طويلة جداً، راجع التاريخ.'; end if;
  v_staff := public.opd_leave_staff_id_(m);   -- يأخذ قفل الموظف، فلا يُسجَّل طلبان متزامنان
  if exists (select 1 from public.opd_team_leaves where staff_id = v_staff and status in ('pending', 'approved')
             and start_date <= p_to and end_date >= p_from) then
    raise exception 'عندك طلب أو إجازة في نفس التواريخ.';
  end if;
  if (select count(*) from public.opd_team_leaves where staff_id = v_staff and status = 'pending') >= 5 then
    raise exception 'عندك طلبات كثيرة بانتظار الاعتماد.';
  end if;
  insert into public.opd_team_leaves (staff_id, leave_type, start_date, end_date, note, source)
  values (v_staff, p_type, p_from, p_to, nullif(left(btrim(coalesce(p_note, '')), 300), ''), 'guide');
  return jsonb_build_object('ok', true);
end $$;

-- إجازاتي: طلبات صاحب الحساب فقط
create or replace function public.opd_leave_mine() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m public.opd_appt_members; v_staff uuid;
begin
  m := public.opd_leave_member_();
  select id into v_staff from public.opd_team where user_id = m.user_id;
  if v_staff is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('type', leave_type, 'start', start_date, 'end', end_date, 'days', days,
           'status', status, 'note', note, 'manager_note', manager_note, 'submitted', submitted_at) order by start_date desc)
         from public.opd_team_leaves where staff_id = v_staff), '[]');
end $$;

-- ===== 5) دمج سجل أُنشئ تلقائياً مع سجل الموظف في الجدول (للمدير فقط) =====
create or replace function public.opd_team_merge(p_from uuid, p_into uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f public.opd_team; i public.opd_team;
begin
  if not public.opd_kpi_is_admin() then raise exception 'للمدير فقط'; end if;
  select * into f from public.opd_team where id = p_from for update;
  select * into i from public.opd_team where id = p_into for update;
  if f.id is null or i.id is null or f.id = i.id then raise exception 'اختر سجلين مختلفين'; end if;
  if not f.auto_created then raise exception 'الدمج للسجلات التي أنشأها الدليل تلقائياً فقط'; end if;
  if i.user_id is not null then raise exception 'سجل الجدول مربوط بحساب آخر'; end if;
  if i.employee_no is not null and f.employee_no is not null and i.employee_no <> f.employee_no then
    raise exception 'الرقم الوظيفي مختلف بين السجلين';
  end if;
  if exists (select 1 from public.opd_team_slots where staff_id = f.id) or exists (select 1 from public.opd_team_roster where staff_id = f.id)
     or exists (select 1 from public.opd_perf_reports where staff_id = f.id) or exists (select 1 from public.opd_perf_charter where staff_id = f.id) then
    raise exception 'السجل مستخدم في الجدول أو التقييم، لا يُدمج آلياً';
  end if;
  update public.opd_team_leaves set staff_id = i.id where staff_id = f.id;
  update public.opd_team set user_id = null, employee_no = null, active = false where id = f.id;
  update public.opd_team set user_id = f.user_id, employee_no = coalesce(i.employee_no, f.employee_no) where id = i.id;
  return jsonb_build_object('ok', true);
end $$;

-- ===== 6) الصلاحيات =====
revoke all on function public.opd_leave_member_() from public, anon, authenticated;
revoke all on function public.opd_leave_staff_id_(public.opd_appt_members) from public, anon, authenticated;
revoke all on function public.opd_leave_me() from public, anon;
revoke all on function public.opd_leave_profile_save(text) from public, anon;
revoke all on function public.opd_leave_submit(text, date, date, text) from public, anon;
revoke all on function public.opd_leave_mine() from public, anon;
revoke all on function public.opd_team_merge(uuid, uuid) from public, anon;
grant execute on function public.opd_leave_me() to authenticated;
grant execute on function public.opd_leave_profile_save(text) to authenticated;
grant execute on function public.opd_leave_submit(text, date, date, text) to authenticated;
grant execute on function public.opd_leave_mine() to authenticated;
grant execute on function public.opd_team_merge(uuid, uuid) to authenticated;

-- الطريقة القديمة (اختيار الاسم + الرقم بدون حساب) كانت تسمح بالتقديم باسم غيره: تُوقف ولا تُحذف
revoke execute on function public.opd_team_leave_submit(uuid, text, text, date, date, text) from public, anon, authenticated;
revoke execute on function public.opd_team_leave_mine(uuid, text) from public, anon, authenticated;
