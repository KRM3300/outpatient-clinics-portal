# Architecture

## Work item
بوابة العيادات الخارجية — 2026-09-28

## Phase 1 services
1. تجربة المريض
2. التحويل الخارجي للمراكز الأعلى

## Stack
- React + TypeScript + Vite
- Supabase Auth
- PostgreSQL via Supabase
- Row Level Security (RLS)

## Security model
Authorization is not based on hidden UI elements. Access is modeled as:
user -> portal role -> service access -> action -> department/record scope.

The browser uses only the public Supabase URL and anon/publishable key. Service-role credentials must never be exposed to the frontend or committed to GitHub.

## Migration strategy
Patient Experience functionality will be migrated as a module, preserving useful workflow concepts without copying the legacy JWT/Express security model verbatim.
External Referrals will be implemented as a separate module sharing auth, profiles, permissions, settings and audit infrastructure.

## Next database migrations
- Patient Experience tables and lookup tables
- External referral workflow tables/status history
- Permission helpers and department/record-scope RLS
- Secure audit functions
- Admin user-management Edge Function or equivalent trusted backend
