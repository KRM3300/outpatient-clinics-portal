/**
 * ILOS | Google Drive -> Supabase | daily aggregated sync
 * Standalone Google Apps Script. Does not edit any Google Sheet.
 *
 * One-time actions in script.google.com (the Sheet owner's Google account):
 * 1) Project Settings: set time zone Asia/Riyadh.
 * 2) Script Properties: SYNC_SECRET = exact long secret placed manually in
 *    public.opd_sync_secrets (do NOT put it in this file).
 * 3) Optional Script Property ALERT_EMAIL. Defaults to effective account email.
 * 4) Run setup() once and authorize Sheets, UrlFetch, MailApp and triggers.
 *
 * Daily time-based triggers run during the 05:00–06:00 Asia/Riyadh window;
 * Apps Script does not guarantee execution at the exact minute 05:00.
 */
const DRIVE_SYNC = Object.freeze({
  BASE_URL: 'https://omugonzzrulsdpnycact.supabase.co/rest/v1/rpc/opd_drive_ingest',
  PUBLIC_KEY: 'sb_publishable_f3IjPvIbMruO9jGb4SmT7Q_NOqgEbXs',
  REQUESTS_ID: '1vJW9HBI8l5gKM-Gr_3VNfoYyqP6xM0SJN1ePGG7rg4g',
  REQUESTS_TAB: 'Form Responses 1',
  SATISFACTION_ID: '1MJCOy564OXznPVqb8YfG02TXAWfLI7ZdOJZlSCIVpu8',
  SATISFACTION_TAB: 'ردود النموذج 1',
  SCHEDULE_ID: '1htAUP32cClYWToDntdR1Pcdi_U7y0Bdy_Kz3r-wgt1Y',
  SCHEDULE_TAB: 'Weekly OPD Schedule',
  STAFF_TAB: 'Staff Names',
  ZONE: 'Asia/Riyadh',
  OWNER_LABEL: 'العيادات الخارجية'
});

function setup() {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!secret || secret.length < 24) {
    throw new Error('أضف مفتاح SYNC_SECRET طويلًا في خصائص السكربت أولاً، دون وضعه داخل الكود.');
  }
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncDrive')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncDrive')
    .timeBased().atHour(5).everyDays(1).inTimezone(DRIVE_SYNC.ZONE).create();
  Logger.log('تم إعداد المزامنة اليومية بين 05:00 و06:00 صباحًا بتوقيت الرياض.');
}

/** Returns only the results of the existing 3 source calculations + VIDA staff names. */
function buildPayload_() {
  let source = 'drive_kpi', filename = '';

  function grid(id, tab) {
    filename = id + ' / ' + tab;
    const spreadsheet = SpreadsheetApp.openById(id);
    const sheet = spreadsheet.getSheetByName(tab);
    if (!sheet) throw new Error('تبويب مفقود: ' + filename);
    const values = sheet.getDataRange().getDisplayValues();
    if (!values.length) throw new Error('المصدر فارغ: ' + filename);
    return values.map(row => row.map(value => String(value == null ? '' : value).trim()));
  }
  const p2 = n => String(n).padStart(2, '0');

  // طلبات المواعيد — EXACTLY the aggregation in kpis/sheets-agg.js:
  // Timestamp in M/D/YYYY; column 2 = service, column 3 = absence reason.
  const g = grid(DRIVE_SYNC.REQUESTS_ID, DRIVE_SYNC.REQUESTS_TAB);
  if (!g.length || !/Timestamp|طابع/.test(g[0][0]) || g[0][1] !== 'نوع الخدمة')
    throw new Error('أعمدة ملف الطلبات تغيّرت');
  const req = {}, RS = [];
  for (const r of g.slice(1)) {
    const m = r[0].match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) continue;
    const mo = m[3] + '-' + p2(m[1]), day = +m[2];
    const M = (req[mo] ??= { mo, days: {}, r: {} });
    const x = (M.days[day] ??= [day, 0, 0, 0]);
    if (r[1] === 'تجديد الموعد') {
      x[1]++;
      const why = (r[2] || '').replace(/\s*\(.*$/, '').trim() || 'غير محدد';
      if (!RS.includes(why)) RS.push(why);
      M.r[why] = (M.r[why] || 0) + 1;
    } else if (r[1] === 'تعديل الموعد') x[2]++;
    else if (r[1] === 'إلغاء الموعد') x[3]++;
  }

  // رضا المرضى — EXACTLY the five axes and scores in sheets-agg.js.
  const s = grid(DRIVE_SYNC.SATISFACTION_ID, DRIVE_SYNC.SATISFACTION_TAB);
  if (!s.length || !/طابع زمني/.test(s[0][0]))
    throw new Error('أعمدة ملف الرضا تغيّرت');
  const AX = ['reception', 'nursing', 'doctor', 'pharmacy', 'facility'],
        SC = { 'ممتاز': 5, 'جيد جدا': 4, 'جيد': 3, 'مقبول': 2, 'ضعيف': 1 };
  const sat = {};
  for (const r of s.slice(1)) {
    const m = r[0].match(/(\d{4})\/(\d{2})\/(\d{2})/);
    if (!m) continue;
    const mo = m[1] + '-' + m[2];
    const t = (sat[mo] ??= { mo, n: 0 });
    t.n++;
    AX.forEach((a, i) => {
      const v = SC[(r[i + 1] || '').trim()];
      if (!v) return;
      t[a + '_n'] = (t[a + '_n'] || 0) + 1;
      t[a + '_sum'] = (t[a + '_sum'] || 0) + v;
      if (v >= 4) t[a + '_top'] = (t[a + '_top'] || 0) + 1;
    });
  }

  // Weekly OPD Schedule — EXACTLY the slots and sessions from sheets-agg.js.
  const w = grid(DRIVE_SYNC.SCHEDULE_ID, DRIVE_SYNC.SCHEDULE_TAB);
  const row = re => w.find(r => re.test(r[0] || ''));
  const n = x => +String(x || '').replace(/٫/g, '.').replace(/[^\d.]/g, '') || 0;
  const used = row(/^Number of weekly clinics/i),
        avail = row(/^Number of available clinics/i),
        perSes = row(/^Total clinics during the sess/i);
  const wk = (w[1] || []).find(x => /^\d{4}\/\d{2}\/\d{2}$/.test(x));
  if (!used || !avail || !wk)
    throw new Error('أعمدة الجدول الأسبوعي تغيّرت');
  const roomIds = new Set(w.filter(r => /^\d{1,2}$/.test(r[0])).map(r => r[0]));
  const nums = used.slice(1).filter(x => x !== '').map(n);
  const sch = {
    week: wk.replace(/\//g, '-'),
    used: n(used[1]), avail: n(avail[1]), rooms: roomIds.size,
    slots: nums[1] || 0, slots_new: nums[2] || 0, slots_fu: nums[3] || 0,
    sessions: perSes ? perSes.slice(2, 17).map(n) : [],
  };

  // Staff Names, sheet gid=2080242207.
  // Row 3 is currently the header; find column names rather than hard-code C/F.
  source = 'vida_doctors';
  const staff = grid(DRIVE_SYNC.SCHEDULE_ID, DRIVE_SYNC.STAFF_TAB);
  const headAt = staff.findIndex(r => r.includes('Clinic') && r.includes('Full Name'));
  if (headAt < 0) throw new Error('أعمدة Staff Names تغيّرت: Clinic أو Full Name غير موجود');
  const h = staff[headAt], clinicIndex = h.indexOf('Clinic'), nameIndex = h.indexOf('Full Name');
  if (clinicIndex < 0 || nameIndex < 0) throw new Error('تعذر تحديد أعمدة قائمة أطباء VIDA');
  const doctors = [], found = new Set();
  for (const r of staff.slice(headAt + 1)) {
    const clinic = (r[clinicIndex] || '').trim(), full_name = (r[nameIndex] || '').trim();
    if (!clinic && !full_name) continue;
    if (!clinic || !full_name) throw new Error('اسم طبيب أو عيادة ناقص في Staff Names');
    if (clinic.length > 120 || full_name.length > 180)
      throw new Error('اسم طويل بشكل غير متوقع في Staff Names');
    const key = clinic.toLocaleLowerCase('en') + '\u0000' + full_name.toLocaleLowerCase('en');
    if (!found.has(key)) { found.add(key); doctors.push({ clinic, full_name }); }
  }
  if (!doctors.length) throw new Error('قائمة أطباء VIDA فارغة؛ لن يُسمح بمسح النسخة السابقة.');
  if (doctors.length > 2500) throw new Error('عدد الأطباء أعلى من الحد المتوقع، راجع Staff Names.');

  return {
    req: Object.values(req).map(M => ({
      mo: M.mo, days: Object.values(M.days).sort((a, b) => a[0] - b[0]),
      r: RS.map(k => M.r[k] || 0)
    })),
    RS,
    sat: Object.values(sat),
    sch,
    doctors
  };
}

function rpc_(secret, payload) {
  const response = UrlFetchApp.fetch(DRIVE_SYNC.BASE_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: DRIVE_SYNC.PUBLIC_KEY,
      Accept: 'application/json'
    },
    payload: JSON.stringify({ p_secret: secret, p_payload: payload }),
    muteHttpExceptions: true,
    followRedirects: false
  });
  const code = response.getResponseCode(), body = response.getContentText();
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (_) { throw new Error('رد Supabase غير صالح (HTTP ' + code + ')'); }
  if (code < 200 || code >= 300) {
    throw new Error('Supabase رفض الاتصال (HTTP ' + code + '): ' +
      String(parsed.message || parsed.error || 'تحقق من تشغيل SQL والمفتاح العام').slice(0,160));
  }
  return parsed;
}

function reportError_(secret, source, details) {
  // Best effort only. If internet/Supabase are down the failed log cannot be sent.
  try {
    rpc_(secret, { type: 'error_report', source,
      message: String(details || 'تعذر المزامنة').slice(0,240) });
  } catch (_) { /* Still email the owner */ }
}

function emailError_(source, filename, details) {
  const props = PropertiesService.getScriptProperties();
  const recipient = props.getProperty('ALERT_EMAIL') ||
    Session.getEffectiveUser().getEmail();
  if (!recipient) {
    Logger.log('لم يُعثر على البريد. ضع ALERT_EMAIL في Script Properties.');
    return;
  }
  const where = filename || 'Google Sheets / Supabase';
  const what = String(details || 'خطأ غير محدد').slice(0,420);
  const action = /أعمدة|تبويب|فارغ|Staff Names|ناقص/.test(what)
    ? 'افتح الملف المحدد وتأكد من اسم التبويب وترتيب الأعمدة وصحة البيانات.'
    : /403|401|secret|مفتاح|رفض/.test(what)
    ? 'تحقق من تنفيذ docs/drive-sync.sql وتطابق SYNC_SECRET مع سر drive_sync في Supabase.'
    : 'راجع اتصال الشبكة وصلاحيات Google Sheets وسجل التنفيذ في Apps Script وSupabase.';
  MailApp.sendEmail({
    to: recipient,
    subject: 'تنبيه: فشل مزامنة بيانات العيادات الخارجية',
    body: 'السلام عليكم،\n\nفشلت المزامنة اليومية للعيادات الخارجية.\n' +
      'المصدر: ' + (source === 'vida_doctors' ? 'قائمة أطباء VIDA' : 'مؤشرات Google Drive') + '\n' +
      'الملف / التبويب: ' + where + '\n' +
      'الخطأ: ' + what + '\n' +
      'الإجراء المطلوب: ' + action + '\n\n' +
      'لم تتضمن هذه الرسالة أسماء مرضى أو بياناتهم.'
  });
}

function syncDrive() {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  let source = 'drive_kpi', filename = '';
  try {
    if (!secret || secret.length < 24)
      throw new Error('مفتاح SYNC_SECRET غير مهيأ في Script Properties.');
    const payload = buildPayload_();
    source = 'drive_kpi';
    const res = rpc_(secret, payload);
    if (!res || res.ok !== true)
      throw new Error('فشل الاستيراد إلى Supabase: ' + String(res && (res.message || res.error) || 'غير معروف'));
    Logger.log('تمت المزامنة: ' + JSON.stringify({
      reports: res.reports, updated_reports: res.updated_reports, doctors: res.doctors
    }));
    return res;
  } catch (err) {
    const errorText = String(err && err.message || err);
    // Keep logs and emails operational; never include the secret, payload or raw rows.
    const label = (/Staff Names|أطباء VIDA/.test(errorText) ? 'vida_doctors' : source);
    if (secret) reportError_(secret, label, errorText);
    try { emailError_(label, filename, errorText); }
    catch (emailErr) { Logger.log('تعذر إرسال البريد؛ تحقق من صلاحيات MailApp.'); }
    Logger.log('فشلت مزامنة العيادات: ' + errorText.slice(0,200));
    throw new Error('فشلت المزامنة؛ راجع إشعار البريد وسجل التنفيذ.');
  }
}
