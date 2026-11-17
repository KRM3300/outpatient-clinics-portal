-- تعديل تقرير عدم الالتزام: للمدير فقط (إضافة سياسة تعديل، بدون حذف أي شيء)
grant update on public.opd_nc_reports to authenticated;
create policy nc_reports_update on public.opd_nc_reports for update to authenticated
  using (public.opd_kpi_is_admin()) with check (public.opd_kpi_is_admin());
