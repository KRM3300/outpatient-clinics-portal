-- Aggregate-only reporting for main OPD dashboards.
-- Patient names, record numbers, identities, mobiles and narrative case text
-- are intentionally absent from every result.
begin;
create or replace function public.opd_export_dashboard(p_section text,p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path=''
as $fn$
declare out_sections jsonb:='[]'::jsonb;
declare r jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660
 then raise exception 'Invalid reporting period'; end if;
 if p_section not in ('kpi','productivity','patient_experience','noncompliance')
 then raise exception 'Invalid report'; end if;
 if (p_section='kpi' and not public.opd_has_perm('kpi_view'))
 or (p_section='productivity' and not public.opd_has_perm('prod_view'))
 or (p_section='patient_experience' and not(public.opd_has_perm('pe_handle') or public.opd_has_perm('pe_supervisor')))
 or (p_section='noncompliance' and not public.opd_has_perm('nc_view'))
 then raise exception 'Not authorized'; end if;

 if p_section='kpi' then
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
   'title','عدد تقارير الأداء حسب النوع','headers',jsonb_build_array('نوع التقرير','عدد التقارير'),
   'rows',coalesce((
    select jsonb_agg(jsonb_build_array(report_type,count) order by count desc)
    from (select report_type,count(*)::int as count from public.opd_kpi_reports
    where period_from<=p_to and period_to>=p_from group by report_type) z
   ),'[]'::jsonb)));
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
   'title','القيم الرقمية لمؤشرات الأداء','headers',jsonb_build_array('نوع التقرير','من','إلى','اسم المؤشر','القيمة'),
   'rows',coalesce((
    select jsonb_agg(jsonb_build_array(report_type,period_from,period_to,metric,value)
      order by period_from desc,report_type,metric)
    from (
      select r.report_type,r.period_from,r.period_to,
       left(m.key,100) as metric,
       case when jsonb_typeof(m.value)='number' then (m.value #>> '{}')::numeric else null end as value
      from public.opd_kpi_reports r
      cross join lateral jsonb_each(
       case when jsonb_typeof(r.summary->'metrics')='object' then r.summary->'metrics' else '{}'::jsonb end
      ) m
      where r.period_from<=p_to and r.period_to>=p_from
        and jsonb_typeof(m.value)='number'
      order by r.period_from desc,r.report_type,m.key
      limit 4000
    ) z
   ),'[]'::jsonb)));
 elsif p_section='productivity' then
  select public.opd_productivity(p_from,p_to) into r;
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
    'title','ملخص إنتاجية الموظفين','headers',jsonb_build_array('المؤشر','العدد'),
    'rows',jsonb_build_array(jsonb_build_array('إجمالي البلاغات',r->>'pe_total'),
      jsonb_build_array('البلاغات المغلقة',r->>'pe_closed'),
      jsonb_build_array('تقارير عدم الالتزام',r->>'nc_total'))));
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
    'title','البلاغات المرفوعة حسب الموظف','headers',jsonb_build_array('الموظف','المرفوعة','المغلقة','المفتوحة'),
    'rows',coalesce((select jsonb_agg(jsonb_build_array(t->>'name',t->>'total',t->>'closed',t->>'open'))
       from jsonb_array_elements(coalesce(r->'raised','[]'::jsonb)) t),'[]'::jsonb)));
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
    'title','البلاغات المغلقة حسب الموظف','headers',jsonb_build_array('الموظف','عدد الإغلاقات','أقل من 8 ساعات','8 إلى 24 ساعة','أكثر من 24 ساعة','متوسط الساعات'),
    'rows',coalesce((select jsonb_agg(jsonb_build_array(t->>'name',t->>'total',t->>'green',t->>'orange',t->>'red',t->>'avg_h'))
      from jsonb_array_elements(coalesce(r->'closers','[]'::jsonb)) t),'[]'::jsonb)));
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
    'title','تقارير عدم الالتزام حسب معدّ التقرير','headers',jsonb_build_array('الموظف','العدد'),
    'rows',coalesce((select jsonb_agg(jsonb_build_array(t->>'name',t->>'total'))
      from jsonb_array_elements(coalesce(r->'nc','[]'::jsonb)) t),'[]'::jsonb)));
 elsif p_section='patient_experience' then
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
   'title','ملخص تجربة المريض','headers',jsonb_build_array('المؤشر','العدد'),
   'rows',(select jsonb_build_array(
    jsonb_build_array('إجمالي البلاغات',count(*)),
    jsonb_build_array('المغلقة',count(*) filter(where status='closed')),
    jsonb_build_array('المفتوحة',count(*) filter(where status is distinct from 'closed')))
    from public.opd_pe_cases
    where (created_at at time zone 'Asia/Riyadh')::date between p_from and p_to)));
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
   'title','البلاغات حسب الحالة','headers',jsonb_build_array('الحالة','العدد'),
   'rows',coalesce((select jsonb_agg(jsonb_build_array(status,total) order by total desc)
      from (select coalesce(status,'غير محدد') status,count(*)::int total
        from public.opd_pe_cases where (created_at at time zone 'Asia/Riyadh')::date between p_from and p_to
        group by 1) a),'[]'::jsonb)));
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
   'title','البلاغات حسب القسم','headers',jsonb_build_array('القسم','العدد'),
   'rows',coalesce((select jsonb_agg(jsonb_build_array(department,total) order by total desc)
      from (select coalesce(nullif(department,''),'غير محدد') department,count(*)::int total
        from public.opd_pe_cases where (created_at at time zone 'Asia/Riyadh')::date between p_from and p_to
        group by 1) a),'[]'::jsonb)));
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
   'title','البلاغات حسب الأولوية','headers',jsonb_build_array('الأولوية','العدد'),
   'rows',coalesce((select jsonb_agg(jsonb_build_array(priority,total) order by total desc)
      from (select coalesce(priority,'غير محدد') priority,count(*)::int total
        from public.opd_pe_cases where (created_at at time zone 'Asia/Riyadh')::date between p_from and p_to
        group by 1) a),'[]'::jsonb)));
 elsif p_section='noncompliance' then
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
   'title','ملخص عدم الالتزام','headers',jsonb_build_array('المؤشر','العدد'),
   'rows',(select jsonb_build_array(jsonb_build_array('إجمالي الملاحظات',count(*)))
     from public.opd_nc_reports
     where (occurred_at at time zone 'Asia/Riyadh')::date between p_from and p_to)));
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
   'title','عدم الالتزام حسب النوع','headers',jsonb_build_array('نوع الملاحظة','العدد'),
   'rows',coalesce((select jsonb_agg(jsonb_build_array(observation_type,total) order by total desc)
      from (select coalesce(nullif(observation_type,''),'غير محدد') observation_type,count(*)::int total
       from public.opd_nc_reports where (occurred_at at time zone 'Asia/Riyadh')::date between p_from and p_to
       group by 1) a),'[]'::jsonb)));
  out_sections:=out_sections||jsonb_build_array(jsonb_build_object(
   'title','عدم الالتزام حسب التخصص','headers',jsonb_build_array('التخصص','العدد'),
   'rows',coalesce((select jsonb_agg(jsonb_build_array(specialty,total) order by total desc)
      from (select coalesce(nullif(specialty,''),'غير محدد') specialty,count(*)::int total
       from public.opd_nc_reports where (occurred_at at time zone 'Asia/Riyadh')::date between p_from and p_to
       group by 1) a),'[]'::jsonb)));
 end if;
 return jsonb_build_object('section',p_section,'from',p_from,'to',p_to,'sections',out_sections);
end
$fn$;
revoke all on function public.opd_export_dashboard(text,date,date) from public,anon;
grant execute on function public.opd_export_dashboard(text,date,date) to authenticated;
commit;