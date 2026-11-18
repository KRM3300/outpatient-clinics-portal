/* دخول المنصة برمز البريد: تنظيف الرمز والبريد ورسائل خطأ واضحة بالعربي (2026-11-18)
   - يحوّل الأرقام العربية (٠-٩) ويحذف المسافات من الرمز.
   - يترجم: «طلب رمز قبل انتهاء الدقيقة» و«رمز قديم أو غير صحيح».
   يُحمَّل بعد مكتبة Supabase، ويغلّف createClient تلقائياً لكل الصفحات. */
(function () {
  if (!window.supabase || window.supabase.__opdOtp) return;
  const AR = "٠١٢٣٤٥٦٧٨٩", FA = "۰۱۲۳۴۵۶۷۸۹";
  const digits = (s) => String(s || "").replace(/[٠-٩]/g, (d) => AR.indexOf(d)).replace(/[۰-۹]/g, (d) => FA.indexOf(d)).replace(/\D/g, "");
  const email = (s) => String(s || "").trim().toLowerCase();
  function arabic(e) {
    if (!e) return e;
    const m = String(e.message || "");
    const wait = m.match(/after (\d+) second/i);
    let t = m;
    if (wait || /rate limit|over_email_send_rate_limit|too many/i.test(m) || e.status === 429) {
      t = "أُرسل لك رمز قبل قليل. اكتب الرمز اللي وصلك في خانة رمز التحقق" + (wait ? "، أو انتظر " + wait[1] + " ثانية إذا تبي رمزاً جديداً." : "، أو انتظر دقيقة إذا تبي رمزاً جديداً.");
    } else if (/expired|invalid/i.test(m) && /token|otp|code/i.test(m)) {
      t = "الرمز غير صحيح أو قديم. اكتب آخر رمز وصلك فقط؛ كل رمز جديد يلغي اللي قبله.";
    } else if (/email/i.test(m) && /invalid/i.test(m)) {
      t = "البريد الإلكتروني غير صحيح.";
    }
    try { e.message = t; return e; } catch (x) { const n = new Error(t); n.status = e.status; return n; }
  }
  function wrap(client) {
    const a = client && client.auth;
    if (!a || a.__opdOtp) return client;
    a.__opdOtp = true;
    const send = a.signInWithOtp.bind(a), verify = a.verifyOtp.bind(a);
    a.signInWithOtp = async (p) => {
      const r = await send(p && p.email ? Object.assign({}, p, { email: email(p.email) }) : p);
      if (r && r.error) r.error = arabic(r.error);
      return r;
    };
    a.verifyOtp = async (p) => {
      const q = p && p.token ? Object.assign({}, p, { token: digits(p.token), email: p.email ? email(p.email) : p.email }) : p;
      const r = await verify(q);
      if (r && r.error) r.error = arabic(r.error);
      return r;
    };
    return client;
  }
  const create = window.supabase.createClient.bind(window.supabase);
  window.supabase.createClient = (...args) => wrap(create(...args));
  window.supabase.__opdOtp = true;
  window.OPDAuth = { code: digits, wrap };
})();
