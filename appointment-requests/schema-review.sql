-- Appointment requests: review and deploy only after security approval.
-- No patient records should be entered during pilot.
create table if not exists public.opd_staff (
 user_id uuid primary key references auth.users(id) on delete cascade,
 full_name text not null,
 employee_number text,
 department text,
 role text not null default 'pending' check(role in ('pending','doctor','nurse','scheduler','supervisor','admin')),
 status text not null default 'pending' check(status in ('pending','approved','rejected','suspended')),
 approved_by uuid references auth.users(id),
 approved_at timestamptz,
 created_at timestamptz not null default now()
);
create table if not exists public.opd_appointment_requests (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('emergency','followup')),
 patient_identifier text not null check(length(trim(patient_identifier)) between 1 and 30),
 patient_name text not null check(length(trim(patient_name)) between 2 and 120),
 clinic_name text not null,
 doctor_name text not null,
 clinic_date date not null,
 period text not null check(period in ('morning','noon','evening')),
 proposed_time time,
 status text not null default 'pending' check(status in ('pending','processing','booked','unable','cancelled')),
 requested_by uuid not null references auth.users(id),
 assigned_to uuid references auth.users(id),
 booked_at timestamptz,
 booking_reference text,
 notification_status text not null default 'not_sent' check(notification_status in ('not_sent','sent','failed')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists opd_requests_status_created on public.opd_appointment_requests(status,created_at desc);
create index if not exists opd_requests_requester on public.opd_appointment_requests(requested_by,created_at desc);
create index if not exists opd_requests_clinic_date on public.opd_appointment_requests(clinic_date,clinic_name);
alter table public.opd_staff enable row level security;
alter table public.opd_appointment_requests enable row level security;
revoke all on public.opd_staff,public.opd_appointment_requests from anon;
grant select,insert on public.opd_staff to authenticated;
grant select,insert,update on public.opd_appointment_requests to authenticated;
-- Users can read only their own staff profile.
create policy opd_staff_self_read on public.opd_staff for select to authenticated using (user_id=(select auth.uid()));
-- Staff onboarding writes should be done through a separately reviewed secure backend,
-- NOT via a user-controlled INSERT into role/status columns.
-- No staff INSERT policy is deliberately defined here.
-- Access decisions use trusted admin-managed staff rows, not editable user metadata.
create policy opd_request_read on public.opd_appointment_requests for select to authenticated using (
 exists(select 1 from public.opd_staff s where s.user_id=(select auth.uid()) and s.status='approved'
 and (s.role in ('scheduler','supervisor','admin') or requested_by=(select auth.uid())))
);
create policy opd_request_create on public.opd_appointment_requests for insert to authenticated with check (
 requested_by=(select auth.uid()) and status='pending' and assigned_to is null and booked_at is null
 and notification_status='not_sent' and booking_reference is null
 and exists(select 1 from public.opd_staff s where s.user_id=(select auth.uid()) and s.status='approved' and s.role in ('doctor','nurse','admin'))
);
-- No client UPDATE policy until a controlled transition endpoint is implemented.
-- This prevents forged booking confirmation, staff approvals and notification status.
