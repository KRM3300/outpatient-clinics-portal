-- صلاحية «الخدمات الإلكترونية: معالجة طلبات المرضى» (eservices) — إضافة للقائمة الموجودة دون حذف أي صلاحية (2026-11-18)
-- الصفحة تقرأ وتكتب في شيت OPD Services Responses عبر دالة Supabase الوسيطة eservices؛ لا تُخزَّن بيانات المرضى في Supabase.
do $$
declare d text;
begin
  select pg_get_constraintdef(c.oid) into d from pg_constraint c
  where c.conname = 'opd_user_perms_perm_check' and c.conrelid = 'public.opd_user_perms'::regclass;
  if d is not null and position('''eservices''' in d) = 0 and position(']' in d) > 0 then
    execute 'alter table public.opd_user_perms drop constraint opd_user_perms_perm_check';
    execute 'alter table public.opd_user_perms add constraint opd_user_perms_perm_check '
            || replace(d, ']', ', ''eservices''::text]');
  end if;
end $$;
