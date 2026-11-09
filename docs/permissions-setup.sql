-- نظام طلب ومنح الصلاحيات الموحّد — بوابة العيادات الخارجية
-- إضافات فقط: لا حذف لأي جدول أو بيانات. الجداول القديمة (opd_pe_access, opd_nc_access, opd_kpi_access) تبقى كما هي.

-- 1) الصلاحيات المعتمدة لكل مستخدم
create table if not exists public.opd_user_perms (
  user_id uuid not null references auth.users(id) on delete cascade,
  perm text not null check (perm in (
    'appt_er_request', 'appt_fu_request', 'appt_er_handle', 'appt_fu_handle',
    'pe_submit', 'pe_handle', 'pe_supervisor',
    'nc_submit', 'nc_view',
    'kpi_view')),
  granted_by uuid references auth.users(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, perm)
);

-- 2) طلبات الصلاحيات من الموظفين
create table if not exists public.opd_perm_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  perms text[] not null default '{}',
  note text check (char_length(note) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id)
);
create index if not exists opd_perm_requests_pending on public.opd_perm_requests (status, created_at desc);

alter table public.opd_user_perms enable row level security;
alter table public.opd_perm_requests enable row level security;

create policy perms_self_read on public.opd_user_perms for select to authenticated
  using (user_id = auth.uid() or public.opd_kpi_is_admin());
create policy perm_req_self_read on public.opd_perm_requests for select to authenticated
  using (user_id = auth.uid() or public.opd_kpi_is_admin());
create policy perm_req_self_insert on public.opd_perm_requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending' and decided_at is null and decided_by is null);

grant select on public.opd_user_perms to authenticated;
grant select, insert on public.opd_perm_requests to authenticated;

-- 3) فحص الصلاحية: المدير أو (عضو معتمد + الصلاحية)
create or replace function public.opd_has_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.opd_kpi_is_admin()
      or exists (select 1 from public.opd_user_perms u
                 join public.opd_appt_members m on m.user_id = u.user_id and m.status = 'approved'
                 where u.user_id = auth.uid() and u.perm = p);
$$;
grant execute on function public.opd_has_perm(text) to authenticated;

-- 4) قائمة المدير: الموظفون + صلاحياتهم + آخر طلب معلّق
create or replace function public.opd_perm_admin_list()
returns table(user_id uuid, full_name text, email text, role text, status text, created_at timestamptz,
              employee_no text, job_title text, department text, phone text,
              perms text[], req_id uuid, req_perms text[], req_note text, req_at timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.opd_kpi_is_admin() then raise exception 'Not authorized'; end if;
  return query
  select m.user_id, m.full_name, au.email::text, m.role, m.status, m.created_at, m.employee_no, m.job_title, m.department, m.phone,
         coalesce((select array_agg(u.perm order by u.perm) from public.opd_user_perms u where u.user_id = m.user_id), '{}'),
         r.id, r.perms, r.note, r.created_at
  from public.opd_appt_members m
  left join auth.users au on au.id = m.user_id
  left join lateral (select * from public.opd_perm_requests q where q.user_id = m.user_id and q.status = 'pending'
                     order by q.created_at desc limit 1) r on true
  order by (r.id is null), coalesce(r.created_at, m.created_at) desc;
end $$;
revoke all on function public.opd_perm_admin_list() from public, anon;
grant execute on function public.opd_perm_admin_list() to authenticated;

-- 5) حفظ صلاحيات موظف (استبدال كامل بالقائمة المختارة) + إقفال طلبه المعلّق
create or replace function public.opd_perm_save(p_user uuid, p_perms text[], p_decision text default 'approved')
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.opd_kpi_is_admin() then raise exception 'Not authorized'; end if;
  if p_user = auth.uid() then raise exception 'Self change is not allowed'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Invalid decision'; end if;
  if p_decision = 'approved' then
    delete from public.opd_user_perms where user_id = p_user and perm <> all (coalesce(p_perms, '{}'));
    insert into public.opd_user_perms (user_id, perm, granted_by)
      select p_user, x, auth.uid() from unnest(coalesce(p_perms, '{}')) x
      on conflict (user_id, perm) do nothing;
    update public.opd_appt_members set status = 'approved' where user_id = p_user and status in ('pending', 'rejected');
  else
    update public.opd_appt_members set status = 'rejected' where user_id = p_user and status = 'pending';
  end if;
  update public.opd_perm_requests set status = p_decision, decided_at = now(), decided_by = auth.uid()
    where user_id = p_user and status = 'pending';
  return 'ok';
end $$;
revoke all on function public.opd_perm_save(uuid, text[], text) from public, anon;
grant execute on function public.opd_perm_save(uuid, text[], text) to authenticated;

-- 6) اسم مقدّم الطلب يظهر في الطلبات
alter table public.opd_appt_requests add column if not exists requester_name text;
alter table public.opd_pe_cases add column if not exists created_by_name text;

create or replace function public.opd_fill_requester_name() returns trigger
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  select full_name into v from public.opd_appt_members where user_id = auth.uid();
  if tg_table_name = 'opd_appt_requests' then new.requester_name := v; else new.created_by_name := v; end if;
  return new;
end $$;
create or replace trigger trg_appt_requester_name before insert on public.opd_appt_requests
  for each row execute function public.opd_fill_requester_name();
create or replace trigger trg_pe_creator_name before insert on public.opd_pe_cases
  for each row execute function public.opd_fill_requester_name();
update public.opd_appt_requests r set requester_name = m.full_name
  from public.opd_appt_members m where m.user_id = r.requested_by and r.requester_name is null;

-- 7) طلبات المواعيد تقرأ الصلاحيات الجديدة
alter policy "approved request read" on public.opd_appt_requests using (
  requested_by = auth.uid()
  or (kind = 'emergency' and public.opd_has_perm('appt_er_handle'))
  or (kind = 'followup' and public.opd_has_perm('appt_fu_handle')));
alter policy "approved request submit" on public.opd_appt_requests with check (
  requested_by = auth.uid() and status = 'pending' and assigned_to is null and booking_reference is null
  and notification_status = 'not_sent'
  and ((kind = 'emergency' and public.opd_has_perm('appt_er_request'))
    or (kind = 'followup' and public.opd_has_perm('appt_fu_request'))));
alter policy "audit admin read" on public.opd_appt_audit using (
  public.opd_has_perm('appt_er_handle') or public.opd_has_perm('appt_fu_handle'));

create or replace function public.opd_appt_can_handle(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.opd_appt_requests r where r.id = p_id and
    ((r.kind = 'emergency' and public.opd_has_perm('appt_er_handle'))
     or (r.kind = 'followup' and public.opd_has_perm('appt_fu_handle'))));
$$;

create or replace function public.opd_appt_set_status(p_id uuid, p_status text, p_booking_reference text default null)
returns void language plpgsql security definer set search_path to '' as $function$
declare v_old text;
begin
  if auth.uid() is null or not public.opd_appt_can_handle(p_id) then raise exception 'Not authorized'; end if;
  if p_status not in ('processing','booked','unable','cancelled') then raise exception 'Invalid status'; end if;
  select status into v_old from public.opd_appt_requests where id = p_id for update;
  if v_old is null then raise exception 'Request not found'; end if;
  if v_old not in ('pending','processing') then raise exception 'Finalized request'; end if;
  if p_status = 'booked' and nullif(btrim(p_booking_reference),'') is null then raise exception 'Booking reference required'; end if;
  update public.opd_appt_requests set status = p_status,
    booking_reference = case when p_status = 'booked' then p_booking_reference else null end,
    assigned_to = auth.uid(), updated_at = now() where id = p_id;
  insert into public.opd_appt_audit(request_id,actor_id,action,details) values(p_id,auth.uid(),p_status,jsonb_build_object('previous',v_old));
end $function$;

create or replace function public.opd_appt_record_notification(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path to '' as $function$
declare v_status text;
begin
  if auth.uid() is null or not public.opd_appt_can_handle(p_id) then raise exception 'Not authorized'; end if;
  if p_status not in ('sent','failed','not_sent') then raise exception 'Invalid notification status'; end if;
  select status into v_status from public.opd_appt_requests where id = p_id for update;
  if v_status is null then raise exception 'Request not found'; end if;
  if v_status <> 'booked' then raise exception 'Notification can only be recorded for booked requests'; end if;
  if nullif(btrim(coalesce(p_note,'')),'') is null then raise exception 'Notification evidence/note required'; end if;
  update public.opd_appt_requests set notification_status = p_status, notification_note = left(p_note,500),
    notification_checked_at = now(), updated_at = now() where id = p_id;
  insert into public.opd_appt_audit(request_id,actor_id,action,details)
    values(p_id,auth.uid(),'notification_'||p_status,jsonb_build_object('note',left(p_note,500)));
end $function$;

create or replace function public.opd_appt_emergency_stats(p_from date, p_to date)
returns table(request_day date, specialty text, referring_doctor text, receiving_doctor text, status text, total bigint)
language plpgsql security definer set search_path to '' as $function$
begin
  if auth.uid() is null or not public.opd_has_perm('appt_er_handle') then raise exception 'Not authorized'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Invalid date range'; end if;
  return query
  select (r.created_at at time zone 'Asia/Riyadh')::date, coalesce(nullif(r.referring_specialty,''), r.clinic_name),
         coalesce(nullif(r.referring_doctor,''), m.full_name), r.doctor_name, r.status, count(*)
  from public.opd_appt_requests r left join public.opd_appt_members m on m.user_id = r.requested_by
  where r.kind = 'emergency' and (r.created_at at time zone 'Asia/Riyadh')::date between p_from and p_to
  group by 1,2,3,4,5 order by 1 desc, 2, 3;
end $function$;

-- 8) تجربة المريض
alter policy "pe cases create" on public.opd_pe_cases with check (
  created_by = auth.uid() and status = 'open' and resolution = '' and assigned_to is null
  and (public.opd_has_perm('pe_submit') or public.opd_has_perm('pe_supervisor')));
alter policy "pe cases read" on public.opd_pe_cases using (
  public.opd_has_perm('pe_submit') or public.opd_has_perm('pe_handle') or public.opd_has_perm('pe_supervisor'));
alter policy "pe cases update" on public.opd_pe_cases
  using (public.opd_has_perm('pe_handle') or public.opd_has_perm('pe_supervisor'))
  with check (public.opd_has_perm('pe_handle') or public.opd_has_perm('pe_supervisor'));

-- 9) عدم الالتزام والمؤشرات: الصلاحيات الجديدة فقط (لا رفع تلقائي حسب الوظيفة)
create or replace function public.opd_nc_can_submit() returns boolean
language sql stable security definer set search_path = public as $$ select public.opd_has_perm('nc_submit'); $$;
create or replace function public.opd_nc_can_view() returns boolean
language sql stable security definer set search_path = public as $$ select public.opd_has_perm('nc_view'); $$;
create or replace function public.opd_kpi_can_view() returns boolean
language sql stable security definer set search_path = public as $$ select public.opd_has_perm('kpi_view'); $$;

-- 10) نقل الصلاحيات الحالية كما هي
insert into public.opd_user_perms (user_id, perm)
select user_id, x from public.opd_pe_access a,
  unnest(case a.role when 'agent' then array['pe_submit'] when 'department' then array['pe_handle']
                     else array['pe_supervisor'] end) x
where a.active on conflict do nothing;
insert into public.opd_user_perms (user_id, perm) select user_id, 'nc_submit' from public.opd_nc_access where can_submit on conflict do nothing;
insert into public.opd_user_perms (user_id, perm) select user_id, 'nc_view' from public.opd_nc_access where can_view on conflict do nothing;
insert into public.opd_user_perms (user_id, perm) select user_id, 'kpi_view' from public.opd_kpi_access where active on conflict do nothing;
insert into public.opd_user_perms (user_id, perm)
  select user_id, 'nc_submit' from public.opd_appt_members
  where status = 'approved' and job_title in ('nurse', 'reception', 'carelink') on conflict do nothing;
insert into public.opd_user_perms (user_id, perm)
  select m.user_id, x from public.opd_appt_members m, unnest(array['appt_er_request', 'appt_fu_request']) x
  where m.status = 'approved' and m.role in ('doctor', 'nurse') on conflict do nothing;
insert into public.opd_user_perms (user_id, perm)
  select m.user_id, x from public.opd_appt_members m, unnest(array['appt_er_handle', 'appt_fu_handle']) x
  where m.status = 'approved' and m.role in ('scheduler', 'supervisor') on conflict do nothing;

-- طلبات معلّقة للمسجّلين الذين ينتظرون الاعتماد، بالصلاحيات الافتراضية لوظيفتهم
insert into public.opd_perm_requests (user_id, perms)
select m.user_id, case coalesce(m.job_title, 'other')
    when 'reception' then array['appt_fu_request','appt_fu_handle','pe_handle','nc_submit']
    when 'carelink'  then array['appt_fu_request','appt_fu_handle','pe_handle','nc_submit']
    when 'pe_agent'  then array['pe_submit','nc_submit']
    when 'doctor' then '{}'::text[] when 'scheduler' then '{}'::text[] when 'other' then '{}'::text[]
    else array['nc_submit'] end
from public.opd_appt_members m
where m.status = 'pending' and not exists (select 1 from public.opd_perm_requests q where q.user_id = m.user_id and q.status = 'pending');

-- 11) صفحات المنح القديمة (عدم الالتزام / المؤشرات) تكتب في الجدول الجديد أيضاً
create or replace function public.opd_nc_grant(p_email text, p_submit boolean, p_view boolean) returns text
language plpgsql security definer set search_path = public, auth as $$
declare v uuid;
begin
  if not public.opd_kpi_is_admin() then raise exception 'not allowed'; end if;
  select id into v from auth.users where lower(email) = lower(trim(p_email));
  if v is null then return 'not_found'; end if;
  delete from public.opd_user_perms where user_id = v and perm in ('nc_submit', 'nc_view');
  insert into public.opd_user_perms (user_id, perm, granted_by)
    select v, x, auth.uid() from unnest(array_remove(array[case when p_submit then 'nc_submit' end, case when p_view then 'nc_view' end], null)) x;
  insert into public.opd_nc_access (user_id, email, can_submit, can_view) values (v, lower(trim(p_email)), p_submit, p_view)
  on conflict (user_id) do update set can_submit = excluded.can_submit, can_view = excluded.can_view, email = excluded.email;
  return 'ok';
end $$;

create or replace function public.opd_kpi_grant(p_email text, p_active boolean default true) returns text
language plpgsql security definer set search_path = public, auth as $$
declare v uuid;
begin
  if not public.opd_kpi_is_admin() then raise exception 'not allowed'; end if;
  select id into v from auth.users where lower(email) = lower(trim(p_email));
  if v is null then return 'not_found'; end if;
  if p_active then insert into public.opd_user_perms (user_id, perm, granted_by) values (v, 'kpi_view', auth.uid()) on conflict do nothing;
  else delete from public.opd_user_perms where user_id = v and perm = 'kpi_view'; end if;
  insert into public.opd_kpi_access (user_id, email, active) values (v, lower(trim(p_email)), p_active)
  on conflict (user_id) do update set active = excluded.active, email = excluded.email;
  return 'ok';
end $$;
