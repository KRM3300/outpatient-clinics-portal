-- طلبات الحجز الموحّدة: معالجة بالحالة (تم / لم يتم) + ملاحظة — 2026-11-24
-- إضافة فقط: خانة ملاحظة المعالج ودالة حفظ جديدة. لا حذف ولا تغيير في RLS أو الدوال القائمة.
-- تم        → booked (يُقفل، بدون تاريخ موعد)
-- لم يتم    → processing (يبقى مفتوحاً مع الملاحظة)
--   إلا «طلب مكرر» و«لا تنطبق عليه ضوابط المسار» → rejected (يُقفل)

alter table public.opd_appt_requests add column if not exists handler_note text;

create or replace function public.opd_booking_set(p_id uuid, p_done boolean, p_note text)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_old text;
  v_note text := left(btrim(coalesce(p_note,'')),500);
  v_new text;
begin
  if auth.uid() is null or not public.opd_appt_can_handle(p_id) then
    raise exception 'Not authorized';
  end if;
  if v_note = '' then raise exception 'Note required'; end if;
  select status into v_old from public.opd_appt_requests where id = p_id for update;
  if v_old is null then raise exception 'Request not found'; end if;
  if v_old not in ('pending','processing') then raise exception 'Finalized request'; end if;

  if p_done then
    v_new := 'booked';
  elsif v_note in ('طلب مكرر','لا تنطبق عليه ضوابط المسار') then
    v_new := 'rejected';
  else
    v_new := 'processing';
  end if;

  update public.opd_appt_requests set
    status = v_new,
    handler_note = v_note,
    rejection_reason = case when v_new = 'rejected' then v_note else rejection_reason end,
    closed_at = case when v_new in ('booked','rejected') then now() else null end,
    assigned_to = auth.uid(),
    updated_at = now()
  where id = p_id;

  insert into public.opd_appt_audit(request_id, actor_id, action, details)
  values (p_id, auth.uid(), case when p_done then 'done' else 'not_done' end,
          jsonb_build_object('previous', v_old, 'status', v_new, 'note', v_note));
  return v_new;
end
$function$;

revoke all on function public.opd_booking_set(uuid, boolean, text) from public, anon;
grant execute on function public.opd_booking_set(uuid, boolean, text) to authenticated;
