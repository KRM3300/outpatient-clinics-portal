-- اختبار بدون أثر: كل شيء داخل معاملة واحدة تنتهي بخطأ متعمّد يحمل النتائج، فيُلغى كل ما كُتب.
do $t$
declare
  r text := '';
  u_link uuid; u_new uuid; u_out uuid; u_adm uuid; v_no text; x jsonb; sid uuid; lid uuid; unl uuid;
  d0 date := (now() at time zone 'Asia/Riyadh')::date + 200;
begin
  select m.user_id into u_link from public.opd_appt_members m join public.opd_team t on t.user_id = m.user_id
   where m.status = 'approved' and m.outpatient_staff
   order by (select count(*) from public.opd_team_leaves l where l.staff_id = t.id) desc limit 1;
  select m.user_id, public.opd_team_norm(m.employee_no) into u_new, v_no from public.opd_appt_members m
   where m.status = 'approved' and m.outpatient_staff
     and not exists (select 1 from public.opd_team t where t.user_id = m.user_id)
     and not exists (select 1 from public.opd_team t where t.employee_no = public.opd_team_norm(m.employee_no)) limit 1;
  select user_id into u_out from public.opd_appt_members where status = 'approved' and not outpatient_staff limit 1;
  select user_id into u_adm from public.opd_appt_members where role = 'admin' and status = 'approved' limit 1;
  r := r || format('[users link=%s new=%s out=%s adm=%s] ', u_link is not null, u_new is not null, u_out is not null, u_adm is not null);

  -- 0) بدون تسجيل دخول
  perform set_config('request.jwt.claims', '{}', true);
  execute 'set local role authenticated';
  x := public.opd_leave_me(); r := r || 'T0 anon:' || (x->>'ok') || ' | ';
  execute 'reset role';

  -- 1) موظف مربوط وبياناته مكتملة + لديه إجازات سابقة
  perform set_config('request.jwt.claims', json_build_object('sub', u_link, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  x := public.opd_leave_me(); r := r || 'T1 me:' || (x->>'ok') || '/needs=' || (x->>'needs_employee_no') || ' ';
  x := public.opd_leave_mine(); r := r || 'mine_before=' || jsonb_array_length(x) || ' ';
  x := public.opd_leave_submit('اعتيادية', d0, d0 + 2, 'اختبار'); r := r || 'submit:' || (x->>'ok') || ' ';
  x := public.opd_leave_mine(); r := r || 'mine_after=' || jsonb_array_length(x) || ' first_days=' || (x->0->>'days') || ' | ';
  -- 5) طلب مكرر/متداخل
  begin x := public.opd_leave_submit('اعتيادية', d0 + 1, d0 + 4, null); r := r || 'T5 dup:ACCEPTED(BAD) | ';
  exception when others then r := r || 'T5 dup:' || sqlerrm || ' | '; end;
  -- 7) الطريقة القديمة (التقديم باسم غيره) موقوفة
  begin perform public.opd_team_leave_submit(gen_random_uuid(), '1234', 'اعتيادية', d0, d0, null); r := r || 'T7 old:OPEN(BAD) | ';
  exception when others then r := r || 'T7 old:' || left(sqlerrm, 40) || ' | '; end;
  execute 'reset role';

  -- 2+3) موظف غير موجود في جدول الفريق ورقمه ناقص
  update public.opd_appt_members set employee_no = null where user_id = u_new;
  perform set_config('request.jwt.claims', json_build_object('sub', u_new, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  x := public.opd_leave_me(); r := r || 'T2 me:' || (x->>'ok') || '/needs=' || (x->>'needs_employee_no') || ' ';
  begin x := public.opd_leave_submit('مرضية', d0, d0, null); r := r || 'submit_noemp:ACCEPTED(BAD) ';
  exception when others then r := r || 'submit_noemp:' || sqlerrm || ' '; end;
  x := public.opd_leave_profile_save(v_no); r := r || 'save:' || (x->>'ok') || ' ';
  begin x := public.opd_leave_profile_save('99999999'); r := r || 'resave:ACCEPTED(BAD) ';
  exception when others then r := r || 'resave:blocked '; end;
  x := public.opd_leave_me(); r := r || 'needs_after=' || (x->>'needs_employee_no') || ' ';
  x := public.opd_leave_submit('مرضية', d0, d0, null); r := r || 'T3 submit:' || (x->>'ok') || ' ';
  x := public.opd_leave_submit('تعويضية', d0 + 10, d0 + 10, null); r := r || 'second:' || (x->>'ok') || ' ';
  execute 'reset role';
  r := r || 'team_rows_for_user=' || (select count(*) from public.opd_team where user_id = u_new)
        || ' auto=' || (select bool_and(auto_created) from public.opd_team where user_id = u_new) || ' | ';

  -- 6) مستخدم من خارج العيادات
  perform set_config('request.jwt.claims', json_build_object('sub', u_out, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  x := public.opd_leave_me(); r := r || 'T6 me:' || (x->>'ok') || ' ';
  begin x := public.opd_leave_submit('اعتيادية', d0, d0, null); r := r || 'submit:ACCEPTED(BAD) | ';
  exception when others then r := r || 'submit:blocked | '; end;
  -- غير المدير لا يدمج
  begin perform public.opd_team_merge(gen_random_uuid(), gen_random_uuid()); r := r || 'merge_nonadmin:OPEN(BAD) | ';
  exception when others then r := r || 'merge_nonadmin:' || sqlerrm || ' | '; end;
  execute 'reset role';

  -- 8) المدير يعتمد ويظهر في جدول الإجازات + الدمج
  select l.id into lid from public.opd_team_leaves l join public.opd_team t on t.id = l.staff_id where t.user_id = u_link and l.start_date = d0;
  perform set_config('request.jwt.claims', json_build_object('sub', u_adm, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := r || 'T8 admin_sees_pending=' || (select count(*) from public.opd_team_leaves where id = lid and status = 'pending') || ' ';
  update public.opd_team_leaves set status = 'approved', decided_at = now() where id = lid;
  x := public.opd_team_month(d0 - extract(dow from d0)::int);
  r := r || 'in_month=' || (select count(*) from jsonb_array_elements(x->'leaves') e
                             where (e->>'start')::date = d0 and e->>'staff_id' = (select id::text from public.opd_team where user_id = u_link)) || ' ';
  select id into unl from public.opd_team where user_id is null and employee_no is null and active and not auto_created limit 1;
  select id into sid from public.opd_team where user_id = u_new;
  x := public.opd_team_merge(sid, unl); r := r || 'merge:' || (x->>'ok') || ' ';
  execute 'reset role';
  r := r || 'moved=' || (select count(*) from public.opd_team_leaves where staff_id = unl and start_date >= d0)
        || ' linked=' || (select (user_id = u_new) from public.opd_team where id = unl)
        || ' old_inactive=' || (select not active from public.opd_team where id = sid);
  perform set_config('request.jwt.claims', json_build_object('sub', u_new, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  x := public.opd_leave_mine(); r := r || ' mine_after_merge=' || jsonb_array_length(x);
  execute 'reset role';

  raise exception 'RESULTS>> %', r;
end $t$;
