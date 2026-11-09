-- صلاحية «دليل الموظف الذكي: اطلاع» + فحص الرقم الوظيفي من صفحة الدليل (يرجع نعم/لا فقط)
alter table public.opd_user_perms drop constraint if exists opd_user_perms_perm_check;
alter table public.opd_user_perms add constraint opd_user_perms_perm_check check (perm in (
  'appt_er_request', 'appt_fu_request', 'appt_er_handle', 'appt_fu_handle',
  'pe_submit', 'pe_handle', 'pe_supervisor', 'nc_submit', 'nc_view', 'kpi_view', 'guide_view'));

create or replace function public.opd_guide_check(p_empno text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.opd_appt_members m
    where m.status = 'approved' and m.employee_no = btrim(p_empno)
      and (m.role = 'admin' or exists (select 1 from public.opd_user_perms u where u.user_id = m.user_id and u.perm = 'guide_view')));
$$;
revoke all on function public.opd_guide_check(text) from public;
grant execute on function public.opd_guide_check(text) to anon, authenticated;
