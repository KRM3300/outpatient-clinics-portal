-- الجدول الشهري الثابت: كل خانة سارية من تاريخ حتى تتغير (بدل الجدول الأسبوعي opd_team_slots)
-- إضافات فقط: جدول جديد + دالة للدليل + نقل جدول أسبوع 15/11 كأساس.

create table if not exists public.opd_team_roster (
  id uuid primary key default gen_random_uuid(),
  shift text not null check (shift in ('A', 'B', 'C')),
  role text not null check (role in ('supervisor', 'reception', 'transfer', 'eye', 'eservices')),
  staff_id uuid references public.opd_team(id),
  label text,
  weekday smallint check (weekday between 0 and 6),   -- null = الأحد إلى الخميس
  one_day boolean not null default false,              -- true = ذلك التاريخ فقط
  valid_from date not null,
  valid_to date,                                       -- null = مستمر حتى يتغير
  sort int not null default 0,
  created_at timestamptz not null default now(),
  check (staff_id is not null or nullif(btrim(label), '') is not null),
  check (valid_to is null or valid_to >= valid_from)
);
create index if not exists opd_team_roster_dates on public.opd_team_roster(valid_from, valid_to);

alter table public.opd_team_roster enable row level security;
revoke all on public.opd_team_roster from anon;
grant select, insert, update, delete on public.opd_team_roster to authenticated;
create policy team_roster_admin on public.opd_team_roster for all to authenticated
  using (public.opd_kpi_is_admin()) with check (public.opd_kpi_is_admin());

-- للدليل: خانات 4 أسابيع + الإجازات المعتمدة فيها (بدون نوع الإجازة)
create or replace function public.opd_team_month(p_from date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'roster', coalesce((select jsonb_agg(jsonb_build_object('shift', r.shift, 'role', r.role, 'staff_id', r.staff_id, 'name', t.name,
                          'label', r.label, 'weekday', r.weekday, 'one_day', r.one_day, 'valid_from', r.valid_from, 'valid_to', r.valid_to)
                          order by r.sort, r.valid_from)
                        from public.opd_team_roster r left join public.opd_team t on t.id = r.staff_id
                        where r.valid_from <= p_from + 27 and (r.valid_to is null or r.valid_to >= p_from)), '[]'),
    'leaves', coalesce((select jsonb_agg(jsonb_build_object('staff_id', l.staff_id, 'name', t.name, 'start', l.start_date, 'end', l.end_date)
                          order by l.start_date)
                        from public.opd_team_leaves l join public.opd_team t on t.id = l.staff_id
                        where l.status = 'approved' and l.start_date <= p_from + 27 and l.end_date >= p_from), '[]'));
$$;
revoke all on function public.opd_team_month(date) from public;
grant execute on function public.opd_team_month(date) to anon, authenticated;

-- الأساس: جدول أسبوع 15/11 (كما في الشيت) ساري من 15/11 فصاعداً
insert into public.opd_team_roster (shift, role, staff_id, label, weekday, valid_from, sort)
select s.shift, s.role, s.staff_id, s.label, s.day, date '2026-11-15', s.sort
from public.opd_team_slots s
where s.week_start = date '2026-11-15'
  and not exists (select 1 from public.opd_team_roster);
