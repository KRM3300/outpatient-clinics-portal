# Unified Booking Requests — staged rollout and data reconciliation

Status: **development branch only**; no deployment, database migration, user-account changes or Google Forms deactivation have been performed.

## Service policy
- Six routes: `followup`, `affiliate`, `low_back`, `breast_screening`, `emergency`, `phc_triage`.
- Emergency **enabled** at first launch (continuity with current service); PHC triage **disabled** unless outpatient management activates it during Mawid outages.
- Always-on routes: follow-up, affiliates, lower-back, breast screening.
- Only approved individual OTP accounts; grant each route independently; `appt_booking_handle` covers all requests for scheduler staff.
- Requests from disabled routes remain visible for completion and in aggregate statistics.
- Follow-up route description: «حجز موعد متابعة من داخل العيادات، في حال تعثّر الحجز من العيادة».
- No file attachments. Record requester identity server-side. Do not mislabel a nurse/other submitting employee as a treating physician.
- Required patient fields: full four-part name, identity, date of birth, mobile. Mother's name only for affiliate route.
- Lower back clinic fixed to Neurosurgery; breast screening fixed to General Surgery.
- 24 real elapsed hours from submission for open-request SLA; maintain actual completion and booked dates separately.
- Booking creates no appointment in VIDA by itself: staff must complete it and record booked date to close, or record a structured rejection reason.
- Historic rows missing real completion timestamps must be **excluded** from 24-hour compliance calculations, not inferred from input times.

## Verified source mapping — NO source passwords to be read or transferred

### Affiliate hospitals
Historical responses: **1,881** candidate rows with named originating facility and clinic, **16** distinct clinics, **5** institutions.
Status cells: 1,343 «تم», 261 «لم يتم», 277 empty. Two potential identical identity+clinic+timestamp combinations require deduplication.
Source fields: timestamp A; patient name B; identity C; birthdate D; mother E; mobile F; facility G; clinic H; referring physician I; status K.
**Never read field J: old shared doctor password.**
Facilities: النبهانية، عقلة الصقور، ضرية، ضلع رشيد، دخنة.
Clinic types (16): Ophthalmology, Surgery, Medical, Dermatology, ENT, Optometry, Gastroenterology, Urology, Endocrinology, Orthopedic, Pediatric Surgery, Pediatric, Plastic Surgery, Rheumatology, Neurosurgery, Psychiatric.

### PHC fallback
Historical responses: **1,688** rows with clinics, **16** clinic types; 478 «تم», 9 «لم يتم», **1,201 empty** status fields. Facility field L is missing in 515 rows; try field G when available, otherwise flag for reconciliation. The historic response source reveals **20** distinct PHCs, while the operating requirement is **21**; do not fabricate the 21st center.
Source fields: timestamp A; patient C; identity D; DOB E; mobile F; facility G or L; physician H; job number I; diagnosis J; clinic K; status M.
**Never read field B: old password.**
Clinics: orthopedic, medical, dermatology, ophthalmology, ENT, OB/Gyn, surgery, pediatrics, diabetes, urology, psychiatry, gastroenterology, endocrinology, pediatric endocrinology, pediatric surgery, pediatric diabetes.

## Safe migration and cut-over
1. Capture a verifiable snapshot of the current main branch, Supabase table definitions and existing appointment request count. Keep current forms operational.
2. Apply the additive and security-reviewed SQL migration **only after compatibility and RLS tests**. Confirm existing `followup` and `emergency` flows remain operational.
3. Import *verified historical closed* form rows into `opd_booking_history` with source row number for idempotence and **without patient names, identity, DOB, mobile or mother's names**. These rows inform counts, not false SLA timestamps.
4. Reconcile «لم يتم» / empty statuses against operational logs. Only genuinely open action items are imported into restricted `opd_appt_requests` with `external_source` + `external_row`, masked from other requesters by RLS. Never auto-mark all statusless rows open.
5. Verify migration totals, source institution/clinic grouping, duplicates, unresolved rows and all currently open legacy portal requests; no row overwrites or losses. Compare historical totals before/after.
6. Conduct scenario tests with approved doctor, PHC doctor, nurse, scheduler, admin, suspended and unauthorized users. Check that staff from one unit cannot read others' patient requests.
7. Switch the portal service card to the unified module *after* end-to-end trials and user approval. Leave the old Google Forms alive while checking live traffic and reconciliation.
8. Disable the two Google Forms **one week after actual successful launch**, after explicit operational acceptance and confirmation no unprocessed responses remain. Keep the original Sheet sources as read-only archives.
9. Phase 2: grouped staff list by category (preview added on this branch), role PHC doctor. Phase 3: unified aggregated report export across performance KPIs, productivity, patient experience, noncompliance and booking; both PDF and proper Excel output must omit patient identifiers.

## Acceptance checks before publication
- Six routes and per-route authorization; 16 clinics in each 16-clinic branch; 21st PHC validated before full PHC rollout.
- Emergency default enabled; PHC fallback off; toggles reversible without deleting requests or analytics.
- All existing portal requests survive unchanged, with old permission checks still honored.
- Booking saves actual date, user and closure timestamp; rejection requires reason; SLA highlights aged open cases.
- Role approval really creates `phc_doctor`, is alphabetically grouped, and uses individual sign-ins.
- Patient data never enters public repository, public dashboards or exported reports.
- Full runtime and mobile browser tests completed; code syntax checks alone are not release acceptance.
