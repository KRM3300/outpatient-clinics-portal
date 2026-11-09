/* يُشغَّل داخل تبويب Google Sheets (docs.google.com) على جهاز البيت.
   يقرأ ملفي "OPD Services Responses" و"رأيك يطورنا" ويجمع أعداداً فقط (بدون أسماء أو هويات أو جوالات)،
   ثم يحفظ النتيجة في window.name وينتقل لصفحة المنصة، وهناك تُستدعى window.kpiSync(). */
(async () => {
  const pol = window.trustedTypes ? trustedTypes.createPolicy("kpi" + Date.now(), { createHTML: (s) => s }) : null;
  async function grid(id, gid) {
    const h = await (await fetch("/spreadsheets/d/" + id + "/htmlview/sheet?headers=true&gid=" + gid)).text();
    const d = new DOMParser().parseFromString(pol ? pol.createHTML(h) : h, "text/html");
    return [...d.querySelectorAll("table tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim()));
  }
  const p2 = (n) => String(n).padStart(2, "0");
  // طلبات المواعيد: Form Responses 1 — التاريخ M/D/YYYY، العمود 1 نوع الخدمة، العمود 2 سبب عدم الحضور
  const g = await grid("1vJW9HBI8l5gKM-Gr_3VNfoYyqP6xM0SJN1ePGG7rg4g", "1671916228");
  if (!g.length || !/Timestamp|طابع/.test(g[0][0]) || g[0][1] !== "نوع الخدمة") throw new Error("أعمدة ملف الطلبات تغيّرت");
  const req = {}, RS = [];
  for (const r of g.slice(1)) {
    const m = r[0].match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) continue;
    const mo = m[3] + "-" + p2(m[1]), day = +m[2];
    const M = (req[mo] ??= { mo, days: {}, r: {} });
    const x = (M.days[day] ??= [day, 0, 0, 0]);
    if (r[1] === "تجديد الموعد") {
      x[1]++;
      const why = (r[2] || "").replace(/\s*\(.*$/, "").trim() || "غير محدد";
      if (!RS.includes(why)) RS.push(why);
      M.r[why] = (M.r[why] || 0) + 1;
    } else if (r[1] === "تعديل الموعد") x[2]++;
    else if (r[1] === "إلغاء الموعد") x[3]++;
  }
  // رضا المرضى: الأعمدة 1-5 (استقبال، تمريض، طبيب، صيدلية، مرافق)
  const s = await grid("1MJCOy564OXznPVqb8YfG02TXAWfLI7ZdOJZlSCIVpu8", "566462599");
  if (!s.length || !/طابع زمني/.test(s[0][0])) throw new Error("أعمدة ملف الرضا تغيّرت");
  const AX = ["reception", "nursing", "doctor", "pharmacy", "facility"], SC = { "ممتاز": 5, "جيد جدا": 4, "جيد": 3, "مقبول": 2, "ضعيف": 1 };
  const sat = {};
  for (const r of s.slice(1)) {
    const m = r[0].match(/(\d{4})\/(\d{2})\/(\d{2})/);
    if (!m) continue;
    const mo = m[1] + "-" + m[2];
    const t = (sat[mo] ??= { mo, n: 0 });
    t.n++;
    AX.forEach((a, i) => {
      const v = SC[(r[i + 1] || "").trim()];
      if (!v) return;
      t[a + "_n"] = (t[a + "_n"] || 0) + 1;
      t[a + "_sum"] = (t[a + "_sum"] || 0) + v;
      if (v >= 4) t[a + "_top"] = (t[a + "_top"] || 0) + 1;
    });
  }
  const out = {
    RS,
    req: Object.values(req).map((M) => ({ mo: M.mo, days: Object.values(M.days).sort((a, b) => a[0] - b[0]), r: RS.map((k) => M.r[k] || 0) })),
    sat: Object.values(sat),
  };
  window.name = "KPIDATA:" + JSON.stringify(out);
  return "ok: requests " + out.req.length + " months, satisfaction " + out.sat.length + " months";
})();
