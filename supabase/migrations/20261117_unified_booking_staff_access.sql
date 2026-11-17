-- Grant unified-booking handling to staff already trusted with BOTH legacy
-- emergency and follow-up queues. Does not grant access to all registrants.
-- Keep physicians, nurses and other categories subject to explicit manager approval.
begin;
insert into public.opd_user_perms (user_id,perm,granted_by)
select m.user_id,'appt_booking_handle',null
from public.opd_appt_members m
where m.status='approved'
 and (m.job_title in ('reception','carelink','scheduler') or m.role in ('scheduler','supervisor'))
 and exists (select 1 from public.opd_user_perms p where p.user_id=m.user_id and p.perm='appt_fu_handle')
 and exists (select 1 from public.opd_user_perms p where p.user_id=m.user_id and p.perm='appt_er_handle')
on conflict (user_id,perm) do nothing;
commit;