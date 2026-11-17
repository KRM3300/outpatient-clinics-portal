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
  LEAVE_COLORS: ['#dd7e6b', '#e06666', '#ea9999', '#ff0000', '#cc0000', '#f4cccc'],
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
   يقرأ Weekly OPD Schedule كما هو: الصف 2 تواريخ الأسبوع، الأعمدة F..T = 5 أيام × 3 فترات،
   العمود A رقم الغرفة (مدمج أحياناً لأكثر من صف)، B العيادة. الخلية الحمراء = إجازة.
   الاسم الكامل من Staff Names (Schedule Name → Full Name)، وتواريخ الإجازة من تبويب الإجازات ثم ملاحظة الخلية. */
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
  const ws = byGid(DRIVE_SYNC.SCHEDULE_GID);
  const range = ws.getDataRange();
  const V = range.getDisplayValues(), BG = range.getBackgrounds(), NT = range.getNotes();
  if (clean((V[0] || [])[5]) !== 'Sunday' || clean((V[0] || [])[17]) !== 'Thursday')
    throw new Error('أعمدة الجدول الأسبوعي تغيّرت: أيام الأسبوع ليست في الأعمدة F..T');
  const WEEK = (V[1] || []).map(clean).filter(x => /^\d{4}\/\d{2}\/\d{2}$/.test(x)).map(x => x.replace(/\//g, '-'));
  if (WEEK.length !== 5) throw new Error('تواريخ الأسبوع في الصف 2 من الجدول الأسبوعي غير مكتملة');

  // Staff Names: Schedule Name → Full Name
  const N = byGid(DRIVE_SYNC.STAFF_GID).getDataRange().getDisplayValues().map(r => r.map(clean));
  const nh = N.findIndex(r => r.includes('Schedule Name') && r.includes('Full Name') && r.includes('Clinic'));
  if (nh < 0) throw new Error('أعمدة Staff Names تغيّرت: Schedule Name أو Full Name غير موجود');
  const si = N[nh].indexOf('Schedule Name'), fi = N[nh].indexOf('Full Name'), ci = N[nh].indexOf('Clinic'), ni = N[nh].indexOf('#');
  const fam = c => String(c || '').toLowerCase().split(/[\s/]+/)[0];
  const exact = {}, family = {}, byName = {};
  for (const r of N.slice(nh + 1)) {
    if (ni >= 0 && !/^\d+$/.test(r[ni] || '')) continue;
    const sn = (r[si] || '').toLowerCase(), full = r[fi] || '';
    if (!sn || !full) continue;
    exact[sn + '|' + (r[ci] || '').toLowerCase()] = full;
    const fk = sn + '|' + fam(r[ci]);
    if (!(fk in family)) family[fk] = full; else if (family[fk] !== full) family[fk] = null;
    if (!(sn in byName)) byName[sn] = full; else if (byName[sn] !== full) byName[sn] = null;
  }
  const fullNameOf = (name, clinic) => {
    const k = name.toLowerCase();
    return exact[k + '|' + clinic.toLowerCase()] || family[k + '|' + fam(clinic)] || byName[k] || '';
  };

  // تبويب الإجازات: اسم الطبيب، بداية الإجازة، نهاية الإجازة، التخصص
  const L = byGid(DRIVE_SYNC.LEAVES_GID).getDataRange().getDisplayValues().map(r => r.map(clean));
  const lh = L.findIndex(r => r.includes('اسم الطبيب') && r.includes('بداية الإجازة') && r.includes('نهاية الإجازة'));
  if (lh < 0) throw new Error('أعمدة تبويب الإجازات تغيّرت: اسم الطبيب / بداية الإجازة / نهاية الإجازة');
  const lName = L[lh].indexOf('اسم الطبيب'), lFrom = L[lh].indexOf('بداية الإجازة'),
        lTo = L[lh].indexOf('نهاية الإجازة'), lSpec = L[lh].indexOf('التخصص');
  const toIso = t => {
    const m = String(t || '').match(/(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})/);
    if (!m) return '';
    let y, mo, d;
    if (m[1].length === 4) { y = m[1]; mo = m[2]; d = m[3]; } else { d = m[1]; mo = m[2]; y = m[3]; }
    if (y.length === 2) y = '20' + y;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return '';
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  };
  const dmy = iso => iso ? iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4) : '';
  const COMMON = { dr: 1, mohammed: 1, mohamed: 1, muhammad: 1, mohammad: 1, ahmed: 1, ahmad: 1, ali: 1, abdullah: 1, abdulla: 1, al: 1, abd: 1 };
  const tokens = t => String(t || '').toLowerCase().replace(/[^a-z؀-ۿ\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !COMMON[w]);
  const leaves = [];
  for (const r of L.slice(lh + 1)) {
    const from = toIso(r[lFrom]), to = toIso(r[lTo]);
    if (!r[lName] || !from || !to) continue;
    leaves.push({ tok: tokens(r[lName]), from, to, spec: (r[lSpec] || '').toUpperCase() });
  }
  const leaveRow = (name, full, clinic, date) => {
    const mine = new Set(tokens(name + ' ' + full));
    const pre = fam(clinic).toUpperCase().slice(0, 4);
    let best = null, bestScore = 0;
    for (const l of leaves) {
      if (l.from > date || l.to < date) continue;
      const hits = l.tok.filter(w => mine.has(w)).length;
      const score = hits * 2 + (pre && l.spec.indexOf(pre) >= 0 ? 1 : 0);
      if (hits && (hits >= 2 || score >= 3) && score > bestScore) { best = l; bestScore = score; }
    }
    return best;
  };

  const red = {};
  DRIVE_SYNC.LEAVE_COLORS.forEach(c => { red[c] = true; });
  const SCH_DATA = [];
  let room = '';
  for (let r = 4; r < V.length; r++) {
    const row = V[r].map(clean);
    if (/^Number of weekly/i.test(row[0] || '')) break;
    if (row[0]) room = row[0];
    const clinic = row[1];
    if (!clinic || !/^\d+$/.test(room)) continue;
    for (let c = 5; c <= 19; c++) {
      const name = row[c];
      if (!name || /^available$/i.test(name)) continue;
      const day = Math.floor((c - 5) / 3), period = (c - 5) % 3, date = WEEK[day];
      const x = { name, clinic, room, day, period, date, leave: !!red[String(BG[r][c] || '').toLowerCase()] };
      const full = fullNameOf(name, clinic);
      if (full) x.fullName = full;
      if (x.leave) {
        // حسب دليل الشيت: ملاحظة الخلية الحمراء فيها تاريخ نهاية الإجازة. سجل الإجازات يكمّل البداية (والنهاية إن غابت الملاحظة).
        const noteEnd = toIso(NT[r][c]);
        const l = leaveRow(name, full, clinic, date);
        if (l) x.leaveStart = dmy(l.from);
        if (noteEnd) x.leaveEnd = dmy(noteEnd); else if (l) x.leaveEnd = dmy(l.to);
      }
      SCH_DATA.push(x);
    }
  }
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
