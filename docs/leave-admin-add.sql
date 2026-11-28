-- تسجيل إجازة لموظف من المدير مباشرة (معتمدة) — 28 نوفمبر 2026. إضافة فقط.
create or replace function public.opd_team_leave_admin_add(p_staff uuid, p_type text, p_from date, p_to date, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.opd_kpi_is_admin() then raise exception 'للمدير فقط'; end if;
  if not exists (select 1 from public.opd_team where id = p_staff and active) then raise exception 'اختر الموظف'; end if;
  if p_type is null or p_type not in ('اعتيادية', 'مرضية', 'تعويضية') then raise exception 'اختر نوع الإجازة'; end if;
  if p_from is null or p_to is null then raise exception 'حدد تاريخ البداية والنهاية'; end if;
  if p_to < p_from then raise exception 'تاريخ النهاية لازم يكون بعد البداية أو نفسها'; end if;
  if p_to - p_from > 120 then raise exception 'مدة الإجازة طويلة جداً، راجع التاريخ'; end if;
  perform pg_advisory_xact_lock(hashtext('opd_leave_staff|' || p_staff::text));
  if exists (select 1 from public.opd_team_leaves where staff_id = p_staff and status in ('pending', 'approved')
             and start_date <= p_to and end_date >= p_from) then
    raise exception 'للموظف طلب أو إجازة في نفس التواريخ';
  end if;
  insert into public.opd_team_leaves (staff_id, leave_type, start_date, end_date, note, status, source, decided_at, decided_by)
  values (p_staff, p_type, p_from, p_to, nullif(left(btrim(coalesce(p_note, '')), 300), ''), 'approved', 'admin', now(), auth.uid());
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.opd_team_leave_admin_add(uuid, text, date, date, text) from public, anon;
grant execute on function public.opd_team_leave_admin_add(uuid, text, date, date, text) to authenticated;
