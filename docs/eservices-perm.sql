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

-- ربط صفحة الخدمات الإلكترونية بسكربت الشيت: رابط السكربت والمفتاح السري (لا يقرؤه إلا دالة eservices بمفتاح الخدمة)
create table if not exists public.opd_eservices_link (
  id integer primary key default 1 check (id = 1),
  script_url text,
  secret text not null,
  created_at timestamptz not null default now()
);
alter table public.opd_eservices_link enable row level security;
revoke all on table public.opd_eservices_link from public, anon, authenticated;

-- السكربت يسجّل مفتاحه مرة واحدة فقط (setupPortalApi)؛ أي محاولة بعدها تُرفض
create or replace function public.opd_eservices_register(p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if p_secret is null or length(p_secret) < 40 or length(p_secret) > 200 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if exists (select 1 from public.opd_eservices_link) then
    return jsonb_build_object('ok', false, 'error', 'already_registered');
  end if;
  insert into public.opd_eservices_link(id, secret) values (1, p_secret);
  return jsonb_build_object('ok', true);
end $fn$;
revoke all on function public.opd_eservices_register(text) from public, anon, authenticated;
grant execute on function public.opd_eservices_register(text) to anon;
