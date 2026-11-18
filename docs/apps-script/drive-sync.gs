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
  REQUESTS_GID: 1671916228,
  SATISFACTION_ID: '1MJCOy564OXznPVqb8YfG02TXAWfLI7ZdOJZlSCIVpu8',
  SATISFACTION_GID: 566462599,
  SCHEDULE_ID: '1htAUP32cClYWToDntdR1Pcdi_U7y0Bdy_Kz3r-wgt1Y',
  SCHEDULE_GID: 0,
  STAFF_GID: 2080242207,
  LEAVES_GID: 304595282,
  SCHEDULE_URL: 'https://omugonzzrulsdpnycact.supabase.co/rest/v1/rpc/opd_schedule_ingest',
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
var DRIVE_SYNC_LAST_FILE = '';
var DRIVE_SYNC_LAST_SOURCE = 'drive_kpi';
function buildPayload_() {
  DRIVE_SYNC_LAST_SOURCE = 'drive_kpi';
  DRIVE_SYNC_LAST_FILE = '';

  function grid(id, gid) {
    DRIVE_SYNC_LAST_FILE = id + ' / gid=' + gid;
    const spreadsheet = SpreadsheetApp.openById(id);
    const sheet = spreadsheet.getSheets().find(s => s.getSheetId() === gid);
    if (!sheet) throw new Error('تبويب بالمعرّف gid غير موجود: ' + DRIVE_SYNC_LAST_FILE);
    const values = sheet.getDataRange().getDisplayValues();
    if (!values.length) throw new Error('المصدر فارغ: ' + DRIVE_SYNC_LAST_FILE);
    return values.map(row => row.map(value => String(value == null ? '' : value).trim()));
  }
  const p2 = n => String(n).padStart(2, '0');

  // طلبات المواعيد — EXACTLY the aggregation in kpis/sheets-agg.js:
  // Timestamp in M/D/YYYY; column 2 = service, column 3 = absence reason.
  const g = grid(DRIVE_SYNC.REQUESTS_ID, DRIVE_SYNC.REQUESTS_GID);
  if (!g.length || !/Timestamp|طابع/.test(g[0][0]) || g[0][1] !== 'نوع الخدمة')
    throw new Error('أعمدة ملف الطلبات تغيّرت');
  const req = {}, RS = [];
  for (const r of g.slice(1)) {
    const m = r[0].match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) continue;
    const mo = m[3] + '-' + p2(m[1]), day = +m[2];
    if (!req[mo]) req[mo] = { mo, days: {}, r: {} };
    const M = req[mo];
    if (!M.days[day]) M.days[day] = [day, 0, 0, 0];
    const x = M.days[day];
    if (r[1] === 'تجديد الموعد') {
      x[1]++;
      const why = (r[2] || '').replace(/\s*\(.*$/, '').trim() || 'غير محدد';
      if (!RS.includes(why)) RS.push(why);
      M.r[why] = (M.r[why] || 0) + 1;
    } else if (r[1] === 'تعديل الموعد') x[2]++;
    else if (r[1] === 'إلغاء الموعد') x[3]++;
  }

  // رضا المرضى — EXACTLY the five axes and scores in sheets-agg.js.
  const s = grid(DRIVE_SYNC.SATISFACTION_ID, DRIVE_SYNC.SATISFACTION_GID);
  if (!s.length || !/طابع زمني/.test(s[0][0]))
    throw new Error('أعمدة ملف الرضا تغيّرت');
  const AX = ['reception', 'nursing', 'doctor', 'pharmacy', 'facility'],
        SC = { 'ممتاز': 5, 'جيد جدا': 4, 'جيد': 3, 'مقبول': 2, 'ضعيف': 1 };
  const sat = {};
  for (const r of s.slice(1)) {
    const m = r[0].match(/(\d{4})\/(\d{2})\/(\d{2})/);
    if (!m) continue;
    const mo = m[1] + '-' + m[2];
    if (!sat[mo]) sat[mo] = { mo, n: 0 };
    const t = sat[mo];
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
  const w = grid(DRIVE_SYNC.SCHEDULE_ID, DRIVE_SYNC.SCHEDULE_GID);
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
  DRIVE_SYNC_LAST_SOURCE = 'vida_doctors';
  const staff = grid(DRIVE_SYNC.SCHEDULE_ID, DRIVE_SYNC.STAFF_GID);
  const headAt = staff.findIndex(r => r.includes('#') && r.includes('Clinic') && r.includes('Full Name'));
  if (headAt < 0) throw new Error('أعمدة Staff Names تغيّرت: Clinic أو Full Name غير موجود');
  const h = staff[headAt], clinicIndex = h.indexOf('Clinic'),
        nameIndex = h.indexOf('Full Name'), numberIndex = h.indexOf('#');
  if (clinicIndex < 0 || nameIndex < 0 || numberIndex < 0)
    throw new Error('تعذر تحديد أعمدة # وClinic وFull Name في قائمة أطباء VIDA');
  const doctors = [], found = new Set();
  for (const r of staff.slice(headAt + 1)) {
    const serial = String(r[numberIndex] || '').trim();
    const clinic = (r[clinicIndex] || '').trim(), full_name = (r[nameIndex] || '').trim();
    // Ignore merged headers, spacer rows, and incomplete rows in Staff Names.
    if (!/^\d+$/.test(serial) || !clinic || !full_name) continue;
    if (clinic.length > 120 || full_name.length > 180) continue;
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

function rpc_(secret, payload, url) {
  const response = UrlFetchApp.fetch(url || DRIVE_SYNC.BASE_URL, {
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
      message: String(details || 'تعذر المزامنة').slice(0,240) },
      source === 'clinic_schedule' ? DRIVE_SYNC.SCHEDULE_URL : DRIVE_SYNC.BASE_URL);
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
      'المصدر: ' + (source === 'vida_doctors' ? 'قائمة أطباء VIDA' :
        source === 'clinic_schedule' ? 'جدول أطباء العيادات (دليل الموظف)' : 'مؤشرات Google Drive') + '\n' +
      'الملف / التبويب: ' + where + '\n' +
      'الخطأ: ' + what + '\n' +
      'الإجراء المطلوب: ' + action + '\n\n' +
      'لم تتضمن هذه الرسالة أسماء مرضى أو بياناتهم.'
  });
}

/* ===== جدول أطباء العيادات (بديل مهمة الخميس) =====
   يقرأ Weekly OPD Schedule: الصف 2 تواريخ الأسبوع، و15 عموداً تبدأ من عمود Sunday = 5 أيام × 3 فترات، A رقم الغرفة (مدمج أحياناً)، B العيادة.
   الإجازة من تبويب Doctors' Leaves for Clinic Closure فقط (الصفوف اللي «هل تم إقفال الجدول بالنظام» = تم)،
   مطابقة بالرقم الوظيفي: Staff Names (Schedule Name → Full Name + Employee No). لون الخلية وملاحظتها لا يُعتمد عليهما. */
function buildSchedule_() {
  DRIVE_SYNC_LAST_SOURCE = 'clinic_schedule';
  const ss = SpreadsheetApp.openById(DRIVE_SYNC.SCHEDULE_ID);
  const byGid = gid => {
    DRIVE_SYNC_LAST_FILE = DRIVE_SYNC.SCHEDULE_ID + ' / gid=' + gid;
    const sh = ss.getSheets().find(x => x.getSheetId() === gid);
    if (!sh) throw new Error('تبويب بالمعرّف gid غير موجود: ' + DRIVE_SYNC_LAST_FILE);
    return sh;
  };
  const clean = v => String(v == null ? '' : v).trim();
  const emp = v => clean(v).replace(/\D/g, '').replace(/^0+/, '');
  const V = byGid(DRIVE_SYNC.SCHEDULE_GID).getDataRange().getDisplayValues();
  // أعمدة الأيام تُحدد من صف العناوين (الأحد = بداية 15 عموداً: 5 أيام × 3 فترات)
  const head = (V[0] || []).map(clean);
  const sun = head.findIndex(x => /^sunday$/i.test(x)), thu = head.findIndex(x => /^thursday$/i.test(x));
  if (sun < 0 || thu !== sun + 12)
    throw new Error('أعمدة الجدول الأسبوعي تغيّرت: لم أجد Sunday..Thursday في الصف الأول بالترتيب المتوقع');
  const WEEK = (V[1] || []).map(clean).filter(x => /^\d{4}\/\d{2}\/\d{2}$/.test(x)).map(x => x.replace(/\//g, '-'));
  if (WEEK.length !== 5) throw new Error('تواريخ الأسبوع في الصف 2 من الجدول الأسبوعي غير مكتملة');

  // Staff Names: Schedule Name (+Clinic) → {الاسم الكامل، الرقم الوظيفي}
  const N = byGid(DRIVE_SYNC.STAFF_GID).getDataRange().getDisplayValues().map(r => r.map(clean));
  const nh = N.findIndex(r => r.includes('Schedule Name') && r.includes('Full Name') && r.includes('Clinic'));
  if (nh < 0) throw new Error('أعمدة Staff Names تغيّرت: Schedule Name أو Full Name غير موجود');
  const H = N[nh], si = H.indexOf('Schedule Name'), fi = H.indexOf('Full Name'), ci = H.indexOf('Clinic'), ni = H.indexOf('#');
  const ei = H.indexOf('Employee No');
  if (ei < 0) throw new Error('عمود Employee No غير موجود في Staff Names — شغّل fillEmployeeNumbers() مرة واحدة');
  const fam = c => String(c || '').toLowerCase().split(/[\s/]+/)[0];
  const exact = {}, family = {}, byName = {}, rows = [];
  const put = (obj, k, v) => { if (!(k in obj)) obj[k] = v; else if (obj[k] && obj[k].full !== v.full) obj[k] = null; };
  for (const r of N.slice(nh + 1)) {
    if (ni >= 0 && !/^\d+$/.test(r[ni] || '')) continue;
    const sn = (r[si] || '').toLowerCase(), full = r[fi] || '';
    if (!sn || !full) continue;
    const v = { full, emp: emp(r[ei]) };
    rows.push({ fam: fam(r[ci]), full, v });
    exact[sn + '|' + (r[ci] || '').toLowerCase()] = v;
    put(family, sn + '|' + fam(r[ci]), v);
    put(byName, sn, v);
  }
  // احتياط: إذا اسم الجدول ما يطابق Schedule Name، نطابق كلماته مع الاسم الكامل داخل نفس التخصص (لازم نتيجة وحدة)
  const words = t => String(t || '').toLowerCase().replace(/^dr\.?\s*/, '').split(/[^a-z]+/).filter(w => w.length > 1)
    .map(w => /^m[uo]ham+[ae]d$/.test(w) ? 'mohammed' : w);
  const byTokens = (name, clinic) => {
    const w = words(name);
    if (!w.length) return null;
    const hits = rows.filter(x => x.fam === fam(clinic)).filter(x => {
      const f = words(x.full);
      return f[0] === w[0] && w.every(t => f.includes(t));
    });
    const uniq = hits.filter((x, i) => hits.findIndex(y => y.full === x.full) === i);
    return uniq.length === 1 ? uniq[0].v : null;
  };
  const doctorOf = (name, clinic) => {
    const k = name.toLowerCase();
    return exact[k + '|' + clinic.toLowerCase()] || family[k + '|' + fam(clinic)] || byName[k] || byTokens(name, clinic) || null;
  };

  // الإجازات المقفلة بالنظام فقط
  const L = byGid(DRIVE_SYNC.LEAVES_GID).getDataRange().getDisplayValues().map(r => r.map(clean));
  const lh = L.findIndex(r => r.includes('بداية الإجازة') && r.includes('نهاية الإجازة') && r.includes('رقم الموظف'));
  if (lh < 0) throw new Error('أعمدة تبويب الإجازات تغيّرت: بداية الإجازة / نهاية الإجازة / رقم الموظف');
  const lFrom = L[lh].indexOf('بداية الإجازة'), lTo = L[lh].indexOf('نهاية الإجازة'),
        lEmp = L[lh].indexOf('رقم الموظف'), lDone = L[lh].indexOf('هل تم إقفال الجدول بالنظام');
  if (lDone < 0) throw new Error('عمود «هل تم إقفال الجدول بالنظام» غير موجود في تبويب الإجازات');
  const toIso = t => {
    const m = String(t || '').match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : '';
  };
  const dmy = iso => iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4);
  const leavesByEmp = {};
  for (const r of L.slice(lh + 1)) {
    if (r[lDone] !== 'تم') continue;
    const e = emp(r[lEmp]), from = toIso(r[lFrom]), to = toIso(r[lTo]);
    if (!e || !from || !to) continue;
    (leavesByEmp[e] = leavesByEmp[e] || []).push({ from, to });
  }

  const SCH_DATA = [], noEmp = {};
  let room = '';
  for (let r = 2; r < V.length; r++) {
    const row = V[r].map(clean);
    if (/^Number of weekly/i.test(row[0] || '')) break;
    if (row[0]) room = row[0];
    const clinic = row[1];
    if (!clinic || !/^\d+$/.test(room)) continue;
    for (let c = sun; c < sun + 15; c++) {
      const name = row[c];
      if (!name || /^available$/i.test(name)) continue;
      const day = Math.floor((c - sun) / 3), period = (c - sun) % 3, date = WEEK[day];
      const x = { name, clinic, room, day, period, date, leave: false };
      const d = doctorOf(name, clinic);
      if (d) x.fullName = d.full;
      if (d && d.emp) {
        const l = (leavesByEmp[d.emp] || []).find(v => v.from <= date && v.to >= date);
        if (l) { x.leave = true; x.leaveStart = dmy(l.from); x.leaveEnd = dmy(l.to); }
      } else noEmp[name + ' (' + clinic + ')'] = true;
      SCH_DATA.push(x);
    }
  }
  const missing = Object.keys(noEmp);
  if (missing.length) Logger.log('بدون رقم وظيفي في Staff Names (لا تظهر إجازاتهم): ' + missing.join('، '));
  if (SCH_DATA.length < 50) throw new Error('الجدول الأسبوعي شبه فاضي (' + SCH_DATA.length + ' فترة) — لم يُنشر حفاظاً على الجدول السابق');
  return { WEEK, SCH_DATA };
}

function syncFailure_(secret, source, err) {
  const errorText = String(err && err.message || err);
  if (secret) reportError_(secret, source, errorText);
  try { emailError_(source, DRIVE_SYNC_LAST_FILE, errorText); }
  catch (emailErr) { Logger.log('تعذر إرسال البريد؛ تحقق من صلاحيات MailApp.'); }
  Logger.log('فشل (' + source + '): ' + errorText.slice(0, 200));
}

/** يحدّث جدول الأطباء فقط — للتجربة اليدوية. */
function syncSchedule() {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  try {
    if (!secret || secret.length < 24) throw new Error('مفتاح SYNC_SECRET غير مهيأ في Script Properties.');
    const res = rpc_(secret, buildSchedule_(), DRIVE_SYNC.SCHEDULE_URL);
    if (!res || res.ok !== true)
      throw new Error('فشل تحديث جدول العيادات: ' + String(res && (res.message || res.error) || 'غير معروف'));
    Logger.log('تم تحديث جدول العيادات: ' + JSON.stringify({ week: res.week, slots: res.slots, leaves: res.leaves }));
    return res;
  } catch (err) {
    syncFailure_(secret, 'clinic_schedule', err);
    throw new Error('فشل تحديث جدول العيادات؛ راجع إشعار البريد وسجل التنفيذ.');
  }
}

function syncDrive() {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  DRIVE_SYNC_LAST_SOURCE = 'drive_kpi';
  DRIVE_SYNC_LAST_FILE = '';
  let kpiFailed = false;
  try {
    if (!secret || secret.length < 24)
      throw new Error('مفتاح SYNC_SECRET غير مهيأ في Script Properties.');
    const payload = buildPayload_();
    const res = rpc_(secret, payload);
    if (!res || res.ok !== true)
      throw new Error('فشل الاستيراد إلى Supabase: ' + String(res && (res.message || res.error) || 'غير معروف'));
    Logger.log('تمت المزامنة: ' + JSON.stringify({
      reports: res.reports, updated_reports: res.updated_reports, doctors: res.doctors
    }));
  } catch (err) {
    const errorText = String(err && err.message || err);
    // Keep logs and emails operational; never include the secret, payload or raw rows.
    const label = DRIVE_SYNC_LAST_SOURCE;
    if (secret) reportError_(secret, label, errorText);
    try { emailError_(label, DRIVE_SYNC_LAST_FILE, errorText); }
    catch (emailErr) { Logger.log('تعذر إرسال البريد؛ تحقق من صلاحيات MailApp.'); }
    Logger.log('فشلت مزامنة العيادات: ' + errorText.slice(0,200));
    kpiFailed = true;
  }
  // جدول الأطباء مستقل: فشله لا يوقف المؤشرات، وفشل المؤشرات لا يوقفه.
  let scheduleFailed = false;
  try { syncSchedule(); } catch (_) { scheduleFailed = true; }
  if (kpiFailed || scheduleFailed)
    throw new Error('فشلت المزامنة' + (kpiFailed ? ' (المؤشرات)' : '') + (scheduleFailed ? ' (جدول العيادات)' : '') + '؛ راجع إشعار البريد وسجل التنفيذ.');
}


/* ===== تشغيل مرة واحدة: إضافة عمود «Employee No» في Staff Names =====
   الأرقام من «دليل الأطباء والموظفين» (مطابقة بالاسم والتخصص، 2026-11-18).
   يكتب فقط في الخلايا الفاضية، ولا يغيّر أي عمود آخر. الطبيب الجديد: اكتب رقمه في نفس العمود. */
const EMPNO_SEED = [["Anesthesia", "BAHAA MOHAMMED MAHMOUD NAJI", "6308572"], ["Cardiology", "MOHAMMED ABDALHAMED MOHAMMED AHMED", "51578206"], ["Cardiology", "AYMAN MOHAMED MOHAMED ELKILANI", "51690531"], ["Cardiology", "MOHAMMED MUQBIL SHUJAA ALHARBI", "1482397"], ["Cardiology", "MOSTAFA IBRAHIM IBRAHIM SAAD", "51644185"], ["Cardiology", "SHIMAA MOHAMMED ABDELDAIM KHATAM", "6537832"], ["Cardiology", "SYED SHUJAUDDIN SYED JALALUDDIN", "6310586"], ["Cardiology", "SULAIMAN SHULAYWIH SANAT ALHARBI", "134840"], ["Chest", "ASAD JAVAID Humayun Jawaid", "51658725"], ["Chest", "ABEER FAROUK AZHARI HASSAN", "6337472"], ["Chest", "RAMADAN SHAWKY ABDELAZIZ ALAWADY", "51646903"], ["Dermatology", "FATMA MOHAMMEDAHMAD MOHAMMED ALHASSAN", "51563459"], ["Dermatology", "HASSAN MOHAMED ALI", "51646967"], ["Dermatology", "MOHAMMED RMAIH M ALRMAIH", "6328983"], ["Dermatology", "NAGI MOHAMED ELHADI GINAWI", "6520171"], ["Dermatology", "NAIRA MOHAMED ABDELAZIZ KASEM", "51646959"], ["Dermatology", "RASHA MOHAMED ALI ABOUZITHAR", "51659712"], ["Dev. & Beh. Disorder", "JAMAL ABDULMAJID SALEM", "6531915"], ["ENT", "MOHAMED NURELDIN MOHAMED MOHAMED FARAH", "51629004"], ["ENT", "HASSAN MAJID BHATTI MAJID NAWAZ BHATTI", "51627589"], ["ENT", "AMJAD MOHAMAD ADEL ALIA", "92138"], ["ENT", "HAMADA MAHMOUD ALHUSSIN", "6533414"], ["ENT", "LOAY KASEM ABDELMOATY MACLID", "6534344"], ["ENT", "MOHAMMAD QAMAR NASIR NASIR AZIZ", "51659693"], ["Gastroenterology", "AMR MOHAMMED HASHEM", "51648963"], ["Gastroenterology", "MOHAMED FEKRY MOHAMED MORSHED", "2570435"], ["Gastroenterology", "MOHAMMED HAMDY GALAL HASSAN", "6336929"], ["Gastroenterology", "MAJED THAAR KHALID ALHARBI", "6536008"], ["Gastroenterology", "YAHYA MUSTAFA CHEHADEH ALCHUMARI", "6317997"], ["Infectious disease", "AHLAM HAMDAN MATROUK ALGUHANI", "6534684"], ["Medical", "AHMED KAMEL ABDELHAMEID WAHBA", "51693579"], ["Medical", "NOUR AHMED ELSHARIF ABDELGADIR", "4853634"], ["Medical", "OSMAN AMIN ALI ELHENDI", "107372"], ["Medical", "QURAT UL AIN MUHAMMAD ARIF", "51637962"], ["Medical", "TAGWA ANWER BASHEIR DERAR", "6337522"], ["Minor Surgery", "AHMAD ISSA ISSA", "6328241"], ["Nephrology", "AMAL MOHAMED SALAHELDIN ANAN", "6535214"], ["Nephrology", "GHADA MOHAMED AHMED ABDALLA", "51660214"], ["Nephrology", "MOHAMED SABRY AMER HABASHY", "51640057"], ["Nephrology", "MOSTAFA ABDELFATTAH SAYED OMAR", "6337755"], ["Neurology", "DINA KHALID ASHMAWI ASHMAWI", "4854612"], ["Neurosurgery", "MUHAMMAD ASIF RAZA GHULAM SARWAR", "51595459"], ["Neurosurgery", "Faizab Ahmed Abbasi", "51708110"], ["Neurosurgery", "TAHA AHMED ALI MOHAMED", "99785"], ["Newborn", "MAHMOUD ABDELRAHEEM MAHMOUD SAYED", "6537474"], ["OB/Gyn", "AMR ABDELHALIM SHARAWY MOSTAFA", "6337625"], ["OB/Gyn", "BASLA SAMER ALOMAR", "6319933"], ["OB/Gyn", "KANEEZ FATIMA MUHAMMAD NAQASH", "76565"], ["OB/Gyn", "OLUMIDE MOJISOLA AYANKUNLE", "6338327"], ["OB/Gyn", "SADIA RAZAQ ALI GAUHAR", "51622750"], ["OB/Gyn", "SAIFEDIN ABDALLAH MOHAMED LAMADIN", "105217"], ["Ophthalmology", "AHMED KHAIRY ELSAYED ETMAN", "51696441"], ["Ophthalmology", "ABDULLAHI IDRIS HOOD IDRIS", "51699112"], ["Ophthalmology", "ABDULLAH AMER A ALASQAH", "42353"], ["Ophthalmology", "AMJAD ALI OMAR SYED RASHID ALI SYED", "6311180"], ["Ophthalmology", "HAJAR SULAIMAN ALI ALMURAYS", "6533733"], ["Ophthalmology", "MOAAZ ABDELLATIF ABDELHADY MOHAMEDELNAGGAR", "51584357"], ["Ophthalmology", "RAYAN SULIMAN A ALKHALIFAH", "6332303"], ["Ophthalmology", "THIGA AHMED ELBASHIR AHMED", "6520170"], ["Optometry", "ALI HUSAIN S ALMALKI", "51519616"], ["Optometry", "ABDULRAHMAN JAZAA OBAID ALHARBI", "51542682"], ["Optometry", "ADEL ABDULLAH MENWER ALHARBI", "6321325"], ["Optometry", "AZIZ ABDULAZIZ HASSAN ALZAHRANI", "0128875"], ["Optometry", "BADER BASHEER MAYUF ALMUTAIRI", "6325919"], ["Optometry", "YOUSEF SALEH SALEM ALHARBI", "4720664"], ["Optometry", "MOHAMMED MUNEER HAMEED ALHARBI", "51539904"], ["Orthopedic", "MOHAMED ELSAYED ABDELWANIS MOHAMED", "6338344"], ["Orthopedic", "ALAA ZENHOM MAHMOUD HASSAN", "6337473"], ["Orthopedic", "HAMDO AL HASSAN", "6527211"], ["Orthopedic", "KAMRAN SAEED SAEED AHMAD", "51635948"], ["Orthopedic", "AHMED MOHAMED MAHMOUD OUN", "6308972"], ["Orthopedic", "ZARNIGAR RIZVI HASSAN RAZA RIZVI", "6320439"], ["Orthopedic", "TAMER ALI AHMED MUSLEH", "6337534"], ["Orthopedic", "WAQAS RAZA MUHAMMAD JEHANZEB", "51644148"], ["Pediatric", "FATIMAH MOHAMMAD IBRAHIM ALOLAYAN", "6537618"], ["Pediatric", "EMAN ABDELKAREEM ABDELRAHMAN ALLAM", "7257317"], ["Pediatric", "ASIM AMJAD HUSSAIN", "51703151"], ["Pediatric", "JAMAL ABDULMAJID SALEM", "6531915"], ["Pediatric", "NEHAL FATHALLA AHMED ELSHOBAKY", "51647055"], ["Pediatric", "SAMI ULLAH NAQIB ULLAH NAQIB ULLAH", "51697288"], ["Pediatric Surgery", "MUHAMMAD SHARIF AHMAD DIN", "51656405"], ["Pediatric Surgery", "FAYAZ UR RAHMAN FAZAL SUBHAN", "51708606"], ["Pediatric Surgery", "MOHAMMED AHMED MOHAMMED FAWZY SALLAM", "51676840"], ["Pediatric Surgery", "NASEEM KHAN GHULAM KHAN", "51654181"], ["Plastic Surgery", "MOHAMED SAAD ABDELHAKIM SADAKA", "51521843"], ["Plastic Surgery", "AHMED TALHA ISMAIL ELBARKY", "6535575"], ["Psychiatric", "ADNAN KHALIFAH S ALKHALIFAH", "112035"], ["Psychiatric", "AHMAD SALEH A ALGHOFAILY", "51591112"], ["Psychiatric", "FATMA HASSANEIN ADAM MAHGOUB", "6320390"], ["Psychiatric", "REHAM ABDELHAMEED ABDELHAMEED ABDELKAREEM", "6337677"], ["Psychotherapy", "ASHAK SAAD B ALHARBI", "6315521"], ["Psychotherapy", "MANAHEL ABDULRAHMAN A ALTWAIJRY", "6337969"], ["Psychotherapy", "NAIF JELOOD A ALHARBI", "115644"], ["Rheumatology", "ABDULLAH HAMAD DHAIFALLAH ALMUTAIRI", "134836"], ["Rheumatology", "EMAN ABDELKARIM RASHAD MOHAMED", "51645721"], ["Rheumatology", "HISHAM ABDULRAHMAN M ALTASSAN", "6332643"], ["Rheumatology", "OMAR ABDULRAHMAN SALEH ALTASAN", "110822"], ["Surgery", "ABDALSATAR ALSHRAFI", "6536793"], ["Surgery", "ABDULHAKIM MOHAMMADMAZHAR ALMASRI", "6309629"], ["Surgery", "ATTA ULLAH JAMAL JAMAL DIN", "6330904"], ["Surgery", "BASSAM MOHAMMED HINDI", "6306253"], ["Surgery", "MUHAMMAD ALI SAFDAR MIAN", "51704333"], ["Surgery", "TANZEEL UZ ZAMAN HAKIM BASHIR AHMED", "51583611"], ["Surgery", "YAZID k GACEM", "51691962"], ["Surgery", "MOHAMED YOUSEF AHMED MOHAMED", "51584666"], ["Urology", "ABDALLA KHALAF MESHREF", "115472"], ["Urology", "ASHRAF ATTIA HUSSEIN ABD EL TAWAB", "6321605"], ["Urology", "AYMAN ALI ABDELGHAFOUR ZAYED", "6533172"], ["Urology", "KAMRAM ABID ABID HUSSAIN", "51708148"], ["Urology", "KHAWAR ALI SARFRAZ AHMED", "51702407"], ["Urology", "RAMADAN RAGAB RAGAB HIBA", "51645325"], ["Urology", "RIYAD ABDAL RASOL ALWICHYAN", "6534569"]];

function fillEmployeeNumbers() {
  const ss = SpreadsheetApp.openById(DRIVE_SYNC.SCHEDULE_ID);
  const sh = ss.getSheets().find(x => x.getSheetId() === DRIVE_SYNC.STAFF_GID);
  if (!sh) throw new Error('تبويب Staff Names غير موجود');
  const values = sh.getDataRange().getDisplayValues();
  const hr = values.findIndex(r => r.includes('Full Name') && r.includes('Clinic'));
  if (hr < 0) throw new Error('صف العناوين في Staff Names غير موجود');
  const H = values[hr];
  let ei = H.indexOf('Employee No');
  if (ei < 0) {
    ei = H.length;
    while (ei > 0 && !String(H[ei - 1]).trim()) ei--;
    sh.getRange(hr + 1, ei + 1).setValue('Employee No');
  }
  const fi = H.indexOf('Full Name'), ci = H.indexOf('Clinic');
  const key = (c, n) => String(c).trim().toLowerCase() + '|' + String(n).trim().replace(/\s+/g, ' ').toLowerCase();
  const map = {};
  EMPNO_SEED.forEach(([c, n, e]) => { map[key(c, n)] = e; });
  let written = 0, unmatched = [];
  for (let r = hr + 1; r < values.length; r++) {
    const full = values[r][fi], clinic = values[r][ci];
    if (!full || !clinic) continue;
    const cur = String(values[r][ei] || '').trim();
    if (cur) continue;
    const e = map[key(clinic, full)];
    if (e) { sh.getRange(r + 1, ei + 1).setNumberFormat('@').setValue(e); written++; }
    else unmatched.push(full + ' (' + clinic + ')');
  }
  Logger.log('تمت كتابة ' + written + ' رقم وظيفي. بدون رقم (أضفه يدوياً): ' + (unmatched.join('، ') || 'لا يوجد'));
}
