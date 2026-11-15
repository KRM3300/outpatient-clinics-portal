-- جدول الموظفين الأسبوعي + طلبات الإجازة (دليل الموظف ← المدير يعتمد من المنصة)
-- إضافات فقط. الإدارة (قراءة وتعديل) للمدير عبر opd_kpi_is_admin()، والدليل يتعامل عبر دوال محددة فقط.

create table if not exists public.opd_team (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  employee_no text unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- خانة في الجدول: أسبوع (يبدأ الأحد) + شفت + دور + موظف أو ملاحظة، ويوم محدد اختياري (0 الأحد … 6 السبت)
create table if not exists public.opd_team_slots (
  id uuid primary key default gen_random_uuid(),
  week_start date not null check (extract(dow from week_start) = 0),
  shift text not null check (shift in ('A', 'B', 'C')),
  role text not null check (role in ('supervisor', 'reception', 'transfer', 'eye', 'eservices')),
  staff_id uuid references public.opd_team(id),
  label text,
  day smallint check (day between 0 and 6),
  sort int not null default 0,
  check (staff_id is not null or nullif(btrim(label), '') is not null)
);
create index if not exists opd_team_slots_week on public.opd_team_slots(week_start);

create table if not exists public.opd_team_leaves (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.opd_team(id),
  leave_type text not null check (leave_type in ('اعتيادية', 'مرضية', 'تعويضية')),
  start_date date not null,
  end_date date not null,
  days int generated always as (end_date - start_date + 1) stored,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  note text,
  manager_note text,
  first_empno boolean not null default false,
  source text not null default 'guide' check (source in ('guide', 'sheet', 'admin')),
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  check (end_date >= start_date)
);
create index if not exists opd_team_leaves_dates on public.opd_team_leaves(start_date, end_date);

alter table public.opd_team enable row level security;
alter table public.opd_team_slots enable row level security;
alter table public.opd_team_leaves enable row level security;
revoke all on public.opd_team, public.opd_team_slots, public.opd_team_leaves from anon;
grant select, insert, update, delete on public.opd_team, public.opd_team_slots, public.opd_team_leaves to authenticated;

create policy team_admin on public.opd_team for all to authenticated
  using (public.opd_kpi_is_admin()) with check (public.opd_kpi_is_admin());
create policy staff_slots_admin on public.opd_team_slots for all to authenticated
  using (public.opd_kpi_is_admin()) with check (public.opd_kpi_is_admin());
create policy staff_leaves_admin on public.opd_team_leaves for all to authenticated
  using (public.opd_kpi_is_admin()) with check (public.opd_kpi_is_admin());

-- ===== دوال الدليل (بدون تسجيل دخول) =====

-- أسماء الموظفين فقط
create or replace function public.opd_team_names() returns table (id uuid, name text)
language sql stable security definer set search_path = public as $$
  select s.id, s.name from public.opd_team s where s.active order by s.name;
$$;

-- جدول أسبوع + من في إجازة (بدون نوع الإجازة) + الإجازات القادمة خلال أسبوعين
create or replace function public.opd_team_week(p_week date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'slots', coalesce((select jsonb_agg(jsonb_build_object('shift', sl.shift, 'role', sl.role, 'staff_id', sl.staff_id,
                         'name', st.name, 'label', sl.label, 'day', sl.day) order by sl.shift, sl.role, sl.sort, st.name)
                       from public.opd_team_slots sl left join public.opd_team st on st.id = sl.staff_id
                       where sl.week_start = p_week), '[]'),
    'leaves', coalesce((select jsonb_agg(jsonb_build_object('staff_id', l.staff_id, 'name', st.name,
                          'start', l.start_date, 'end', l.end_date) order by l.start_date)
                        from public.opd_team_leaves l join public.opd_team st on st.id = l.staff_id
                        where l.status = 'approved' and l.start_date <= p_week + 20 and l.end_date >= p_week), '[]'));
$$;

create or replace function public.opd_team_norm(p text) returns text
language sql immutable as $$
  select regexp_replace(translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '\D', '', 'g');
$$;

-- رفع طلب إجازة: الرقم الوظيفي يُحفظ أول مرة، وبعدها لازم يطابق الاسم
create or replace function public.opd_team_leave_submit(p_staff uuid, p_empno text, p_type text, p_from date, p_to date, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_no text := public.opd_team_norm(p_empno);
  v_staff public.opd_team;
  v_first boolean := false;
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  select * into v_staff from public.opd_team where id = p_staff and active;
  if not found then raise exception 'اختر اسمك من القائمة'; end if;
  if length(v_no) < 4 or length(v_no) > 12 then raise exception 'اكتب رقمك الوظيفي بشكل صحيح'; end if;
  if v_staff.employee_no is null then
    if exists (select 1 from public.opd_team where employee_no = v_no) then raise exception 'الرقم الوظيفي مسجل لموظف آخر'; end if;
    update public.opd_team set employee_no = v_no where id = p_staff;
    v_first := true;
  elsif v_staff.employee_no <> v_no then
    raise exception 'الرقم الوظيفي لا يطابق الاسم';
  end if;
  if p_type not in ('اعتيادية', 'مرضية', 'تعويضية') then raise exception 'اختر نوع الإجازة'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'تاريخ النهاية لازم يكون بعد البداية أو نفسها'; end if;
  if p_from < v_today - 30 then raise exception 'تاريخ البداية قديم جداً'; end if;
  if p_to - p_from > 120 then raise exception 'مدة الإجازة طويلة جداً، راجع التاريخ'; end if;
  if exists (select 1 from public.opd_team_leaves where staff_id = p_staff and status in ('pending', 'approved')
             and start_date <= p_to and end_date >= p_from) then
    raise exception 'عندك طلب أو إجازة في نفس التواريخ';
  end if;
  if (select count(*) from public.opd_team_leaves where staff_id = p_staff and status = 'pending') >= 5 then
    raise exception 'عندك طلبات كثيرة بانتظار الاعتماد';
  end if;
  insert into public.opd_team_leaves (staff_id, leave_type, start_date, end_date, note, first_empno)
  values (p_staff, p_type, p_from, p_to, nullif(left(btrim(coalesce(p_note, '')), 300), ''), v_first);
  return jsonb_build_object('ok', true, 'first', v_first);
end $$;

-- إجازاتي: طلبات الموظف نفسه (بالاسم + الرقم)
create or replace function public.opd_team_leave_mine(p_staff uuid, p_empno text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_staff public.opd_team;
begin
  select * into v_staff from public.opd_team where id = p_staff;
  if not found or v_staff.employee_no is null or v_staff.employee_no <> public.opd_team_norm(p_empno) then
    raise exception 'الرقم الوظيفي لا يطابق الاسم';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('type', leave_type, 'start', start_date, 'end', end_date, 'days', days,
           'status', status, 'note', note, 'manager_note', manager_note, 'submitted', submitted_at) order by start_date desc)
         from public.opd_team_leaves where staff_id = p_staff), '[]');
end $$;

revoke all on function public.opd_team_names() from public;
revoke all on function public.opd_team_week(date) from public;
revoke all on function public.opd_team_leave_submit(uuid, text, text, date, date, text) from public;
revoke all on function public.opd_team_leave_mine(uuid, text) from public;
grant execute on function public.opd_team_names() to anon, authenticated;
grant execute on function public.opd_team_week(date) to anon, authenticated;
grant execute on function public.opd_team_leave_submit(uuid, text, text, date, date, text) to anon, authenticated;
grant execute on function public.opd_team_leave_mine(uuid, text) to anon, authenticated;

-- ===== البيانات الأولية من شيت «جدول موظفي العيادات + الإجازات» =====
insert into public.opd_team (name) values
  ('عايد الحربي'), ('عبد الرحمن الحربي'), ('محمد العمير'), ('رائد المريس'), ('إبراهيم العليان'),
  ('ماجد العساف'), ('علي الصقيه'), ('جمعان الحربي'), ('صالح الحناكي'), ('ثامر الحبس'), ('مشعل الزيدي'),
  ('عبد الله المطيري'), ('بدر الحصيني'), ('محمد الجمعة'), ('عبد العزيز علي الحربي'), ('الملاح'),
  ('مساعد الجدعي'), ('محمد الوقيت'), ('فهد الحربي'), ('عادل الحربي')
on conflict (name) do nothing;

-- إجازات 2026 من الشيت (كلها اعتيادية ومعتمدة)؛ طلب فهد 1–2/11 داخل طلبه 1–5/11 فدخل مرة واحدة
insert into public.opd_team_leaves (staff_id, leave_type, start_date, end_date, status, source, submitted_at, decided_at)
select s.id, 'اعتيادية', v.f::date, v.t::date, 'approved', 'sheet', v.f::date, v.f::date
from (values
  ('محمد الجمعة', '2026-01-11', '2026-01-15'), ('محمد الجمعة', '2026-02-05', '2026-02-05'),
  ('محمد الجمعة', '2026-04-19', '2026-04-23'), ('مساعد الجدعي', '2026-06-28', '2026-07-23'),
  ('عبد الرحمن الحربي', '2026-07-05', '2026-07-30'), ('محمد الجمعة', '2026-08-02', '2026-08-20'),
  ('عادل الحربي', '2026-08-02', '2026-08-06'), ('جمعان الحربي', '2026-08-23', '2026-09-03'),
  ('عادل الحربي', '2026-09-03', '2026-09-03'), ('فهد الحربي', '2026-11-01', '2026-11-05'),
  ('عايد الحربي', '2026-11-15', '2026-12-03')
) as v(n, f, t)
join public.opd_team s on s.name = v.n
where not exists (select 1 from public.opd_team_leaves x where x.source = 'sheet' and x.staff_id = s.id and x.start_date = v.f::date);

-- جدول أسبوعي 15/11 و 22/11 كما في الشيت: صفوف الأحد–الثلاثاء للأسبوع كله، وصفوف الأربعاء والخميس والسبت ليومها
insert into public.opd_team_slots (week_start, shift, role, staff_id, label, day, sort)
select w.week, v.shift, v.role, s.id, v.label, v.day, v.sort
from (values (date '2026-11-15'), (date '2026-11-22')) as w(week)
cross join (values
  ('A', 'supervisor', 'عايد الحربي', null, null::smallint, 1),
  ('A', 'reception', 'عبد الرحمن الحربي', null, null, 1), ('A', 'reception', 'محمد العمير', null, null, 2), ('A', 'reception', 'رائد المريس', null, null, 3),
  ('A', 'transfer', 'الملاح', null, 3, 1), ('A', 'transfer', 'مساعد الجدعي', null, 4, 2),
  ('A', 'eye', 'إبراهيم العليان', null, null, 1),
  ('B', 'supervisor', 'ماجد العساف', null, null, 1), ('B', 'supervisor', null, 'إدارة العيادات', 3, 2), ('B', 'supervisor', 'محمد الوقيت', null, 4, 3),
  ('B', 'reception', 'علي الصقيه', null, null, 1), ('B', 'reception', 'جمعان الحربي', null, null, 2), ('B', 'reception', 'صالح الحناكي', null, null, 3),
  ('B', 'transfer', 'ثامر الحبس', null, null, 1), ('B', 'transfer', 'الملاح', null, 3, 2), ('B', 'transfer', 'فهد الحربي', null, 4, 3),
  ('B', 'eye', 'مشعل الزيدي', null, null, 1),
  ('B', 'eservices', 'عبد العزيز علي الحربي', null, null, 1), ('B', 'eservices', 'عبد العزيز علي الحربي', null, 6, 2),
  ('C', 'supervisor', 'عبد الله المطيري', null, null, 1),
  ('C', 'reception', 'بدر الحصيني', null, null, 1), ('C', 'reception', 'محمد الجمعة', null, null, 2)
) as v(shift, role, n, label, day, sort)
left join public.opd_team s on s.name = v.n
where not exists (select 1 from public.opd_team_slots x where x.week_start = w.week);
