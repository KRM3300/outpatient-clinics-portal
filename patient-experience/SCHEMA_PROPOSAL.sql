-- Proposed Patient Experience schema. REVIEW BEFORE EXECUTION.
-- Existing Supabase project: outpatient-clinics-portal
-- Auth users are shared with OPD; no new authentication provider.
-- Do not run against production until security/privacy approval and RLS review.
begin;
create table if not exists public.px_members (
 user_id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null default '',
 department text,
 role text not null default 'pending' check (role in ('pending','px_admin','px_staff','department_supervisor','department_staff','viewer')),
 status text not null default 'pending' check (status in ('pending','approved','suspended')),
 created_at timestamptz not null default now()
);
create table if not exists public.px_cases (
 id uuid primary key default gen_random_uuid(),
 reference_number bigint generated always as identity unique,
 kind text not null check (kind in ('complaint','report','observation')),
 title text not null check (length(btrim(title)) between 3 and 200),
 description text not null,
 category text not null default 'other',
 source text not null default 'other',
 department text not null,
 priority text not null default 'normal' check (priority in ('normal','high','urgent')),
 status text not null default 'open' check (status in ('open','assigned','in_progress','transferred','escalated','closed','reopened')),
 assigned_to uuid references auth.users(id),
 created_by uuid not null references auth.users(id),
 due_at timestamptz,
 resolution text,
 closed_at timestamptz,
 closed_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists public.px_case_events (
 id uuid primary key default gen_random_uuid(),
 case_id uuid not null references public.px_cases(id) on delete restrict,
 actor_id uuid not null references auth.users(id),
 action text not null,
 note text not null,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index if not exists px_cases_department_status_idx on public.px_cases(department,status);
create index if not exists px_cases_assignee_idx on public.px_cases(assigned_to);
create index if not exists px_case_events_case_idx on public.px_case_events(case_id,created_at);
alter table public.px_members enable row level security;
alter table public.px_cases enable row level security;
alter table public.px_case_events enable row level security;
-- No blanket authenticated access. Security policies will be applied
-- only after verification of exact account-to-department mapping.
-- Until policies exist, client access is denied by default.
commit;
