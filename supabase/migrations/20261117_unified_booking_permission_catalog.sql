-- Retain all existing permissions and extend check-list for unified booking.
begin;
alter table public.opd_user_perms drop constraint if exists opd_user_perms_perm_check;
alter table public.opd_user_perms add constraint opd_user_perms_perm_check
check (perm in ('appt_er_request','appt_fu_request','appt_er_handle','appt_fu_handle','pe_submit','pe_handle','pe_supervisor','pe_alert','nc_submit','nc_view','kpi_view','guide_view','schedule_view','prod_view','appt_affiliate_request','appt_low_back_request','appt_breast_request','appt_phc_triage_request','appt_booking_handle','appt_booking_admin'));
commit;