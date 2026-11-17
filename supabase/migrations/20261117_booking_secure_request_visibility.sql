-- Reader access follows approved membership and currently authorized routes.
-- Prevent suspended users and users with revoked route access from reading
-- patient-level requests solely because they created them earlier.
begin;
drop policy if exists "approved request read" on public.opd_appt_requests;
create policy "approved request read" on public.opd_appt_requests for select to authenticated
using (
  (
    requested_by=(select auth.uid()) and
    exists(select 1 from public.opd_appt_members m where m.user_id=(select auth.uid()) and m.status='approved')
    and (
      (kind='emergency' and public.opd_has_perm('appt_er_request'))
      or (kind='followup' and public.opd_has_perm('appt_fu_request'))
      or (kind='affiliate' and public.opd_has_perm('appt_affiliate_request'))
      or (kind='low_back' and public.opd_has_perm('appt_low_back_request'))
      or (kind='breast_screening' and public.opd_has_perm('appt_breast_request'))
      or (kind='phc_triage' and public.opd_has_perm('appt_phc_triage_request'))
    )
  )
  or (kind='emergency' and public.opd_has_perm('appt_er_handle'))
  or (kind='followup' and public.opd_has_perm('appt_fu_handle'))
);
drop policy if exists "new route requester read own requests" on public.opd_appt_requests;
-- New routes are now handled by the same secured, six-route read policy above.
commit;