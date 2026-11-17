-- Unified booking requests: staged migration for review.
-- NOT applied to production by committing this file.
-- Existing emergency/follow-up rows are retained without rewriting patient data.
begin;

alter table public.opd_appt_requests
  add column if not exists patient_dob date,
  add column if not exists patient_mobile text,
  add column if not exists mother_name text,
  add column if not exists source_facility text,
  add column if not exists diagnosis_reason text,
  add column if not exists request_note text,
  add column if not exists booked_date date,
  add column if not exists rejection_reason text,
  add column if not exists closed_at timestamptz,
  add column if not exists external_source text,
  add column if not exists external_row integer;

-- For referrals and affiliate services, requested clinic date/doctor/period may
-- legitimately be unknown; booked_date is instead recorded at closure.
alter table public.opd_appt_requests
  alter column clinic_date drop not null,
  alter column doctor_name drop not null,
  alter column period drop not null,
  alter column requested_by drop not null;

alter table public.opd_appt_requests
  drop constraint if exists opd_appt_requests_kind_check;
alter table public.opd_appt_requests
  add constraint opd_appt_requests_kind_check
  check (kind in ('followup','affiliate','low_back','breast_screening','emergency','phc_triage'));

alter table public.opd_appt_requests
  drop constraint if exists opd_appt_requests_status_check;
alter table public.opd_appt_requests
  add constraint opd_appt_requests_status_check
  check (status in ('pending','processing','booked','unable','rejected','cancelled'));

alter table public.opd_appt_requests
  add constraint opd_booking_patient_mobile_length
  check (patient_mobile is null or char_length(patient_mobile) <= 20);
alter table public.opd_appt_requests
  add constraint opd_booking_mother_name_length
  check (mother_name is null or char_length(mother_name) <= 120);
alter table public.opd_appt_requests
  add constraint opd_booking_request_note_length
  check (request_note is null or char_length(request_note) <= 1000);
alter table public.opd_appt_requests
  add constraint opd_booking_reason_length
  check (diagnosis_reason is null or char_length(diagnosis_reason) <= 1000);

create unique index if not exists opd_booking_legacy_unique
  on public.opd_appt_requests(external_source,external_row)
  where external_source is not null and external_row is not null;
create index if not exists opd_booking_kind_created
  on public.opd_appt_requests(kind,created_at desc);
create index if not exists opd_booking_status_created
  on public.opd_appt_requests(status,created_at desc);

alter table public.opd_appt_members
  drop constraint if exists opd_appt_members_role_check;
alter table public.opd_appt_members
  add constraint opd_appt_members_role_check
  check (role in ('pending','doctor','phc_doctor','nurse','scheduler','supervisor','admin'));

create table if not exists public.opd_booking_route_settings(
  kind text primary key check (kind in ('emergency','phc_triage')),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.opd_booking_route_settings(kind,enabled)
values ('emergency',true),('phc_triage',false)
on conflict (kind) do nothing;

alter table public.opd_booking_route_settings enable row level security;
create policy "approved members read booking route settings"
  on public.opd_booking_route_settings for select to authenticated
  using (exists(select 1 from public.opd_appt_members m
                where m.user_id=(select auth.uid()) and m.status='approved'));
create policy "booking admins change route settings"
  on public.opd_booking_route_settings for update to authenticated
  using (public.opd_has_perm('appt_booking_admin'))
  with check (public.opd_has_perm('appt_booking_admin'));
grant select,update on public.opd_booking_route_settings to authenticated;

create or replace function public.opd_booking_route_enabled(p_kind text)
returns boolean language sql stable security definer set search_path=''
as $function$
  select case when p_kind in ('emergency','phc_triage')
              then coalesce((select s.enabled from public.opd_booking_route_settings s where s.kind=p_kind),false)
              else true end;
$function$;
revoke all on function public.opd_booking_route_enabled(text) from public,anon;
grant execute on function public.opd_booking_route_enabled(text) to authenticated;

-- Retain old permissions; use a separate permission for each new route.
drop policy if exists "approved request submit" on public.opd_appt_requests;
create policy "approved request submit" on public.opd_appt_requests
for insert to authenticated with check (
  requested_by=(select auth.uid()) and status='pending'
  and assigned_to is null and booking_reference is null
  and notification_status='not_sent'
  and public.opd_booking_route_enabled(kind)
  and (
    (kind='emergency' and public.opd_has_perm('appt_er_request')) or
    (kind='followup' and public.opd_has_perm('appt_fu_request')) or
    (kind='affiliate' and public.opd_has_perm('appt_affiliate_request')) or
    (kind='low_back' and public.opd_has_perm('appt_low_back_request')) or
    (kind='breast_screening' and public.opd_has_perm('appt_breast_request')) or
    (kind='phc_triage' and public.opd_has_perm('appt_phc_triage_request'))
  )
);
create policy "unified booking handlers read requests"
  on public.opd_appt_requests for select to authenticated
  using (public.opd_has_perm('appt_booking_handle'));
create policy "new route requester read own requests"
  on public.opd_appt_requests for select to authenticated
  using (kind in ('affiliate','low_back','breast_screening','phc_triage')
         and requested_by=(select auth.uid()));

-- Update legacy action authorization without changing existing operation semantics.
create or replace function public.opd_appt_can_handle(p_id uuid)
returns boolean language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1 from public.opd_appt_requests r where r.id=p_id and
      (public.opd_has_perm('appt_booking_handle') or
       (r.kind='emergency' and public.opd_has_perm('appt_er_handle')) or
       (r.kind='followup' and public.opd_has_perm('appt_fu_handle')))
  );
$function$;

-- Explicit closure captures actual booked date or documented rejection reason.
create or replace function public.opd_booking_close(
 p_id uuid, p_outcome text, p_booked_date date default null,
 p_rejection_reason text default null, p_booking_reference text default null
) returns void language plpgsql security definer set search_path=''
as $function$
declare v_old text;
begin
 if auth.uid() is null or not public.opd_appt_can_handle(p_id) then
   raise exception 'Not authorized';
 end if;
 if p_outcome not in ('booked','rejected') then raise exception 'Invalid outcome'; end if;
 if p_outcome='booked' and p_booked_date is null then raise exception 'Booking date required'; end if;
 if p_outcome='rejected' and nullif(btrim(coalesce(p_rejection_reason,'')),'') is null then
   raise exception 'Rejection reason required';
 end if;
 select status into v_old from public.opd_appt_requests where id=p_id for update;
 if v_old is null then raise exception 'Request not found'; end if;
 if v_old not in ('pending','processing') then raise exception 'Finalized request'; end if;
 update public.opd_appt_requests set
   status=p_outcome,
   booked_date=case when p_outcome='booked' then p_booked_date else null end,
   rejection_reason=case when p_outcome='rejected' then left(btrim(p_rejection_reason),500) else null end,
   booking_reference=case when p_outcome='booked' then nullif(btrim(p_booking_reference),'') else null end,
   closed_at=now(), assigned_to=auth.uid(), updated_at=now()
 where id=p_id;
 insert into public.opd_appt_audit(request_id,actor_id,action,details)
 values(p_id,auth.uid(),p_outcome,
   jsonb_build_object('previous',v_old,'booked_date',p_booked_date,'rejection_reason',left(coalesce(p_rejection_reason,''),500)));
end
$function$;
revoke all on function public.opd_booking_close(uuid,text,date,text,text) from public,anon;
grant execute on function public.opd_booking_close(uuid,text,date,text,text) to authenticated;

-- Historic closed Google Forms rows: statistical-only import, no patient identifiers.
-- Pending/unfulfilled responses must be reconciled into opd_appt_requests before cut-over.
create table if not exists public.opd_booking_history(
 source text not null check (source in ('affiliate_google_form','phc_google_form')),
 source_row integer not null check (source_row>0),
 request_date date,
 route text not null check (route in ('affiliate','phc_triage')),
 source_facility text,
 clinic_name text,
 doctor_name text,
 outcome text not null,
 imported_at timestamptz not null default now(),
 primary key (source,source_row)
);
alter table public.opd_booking_history enable row level security;
revoke all on public.opd_booking_history from anon,authenticated;
create index if not exists opd_booking_history_date_idx
  on public.opd_booking_history(request_date,route);
commit;