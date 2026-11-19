/*******************************************************
 * واجهة منصة العيادات الخارجية ← شيت OPD Services Responses
 * صفحة «الخدمات الإلكترونية» للموظفين (إضافة فقط — لا تغيّر أي دالة موجودة)
 *
 * - تُستدعى من دالة Supabase الوسيطة (eservices) بمفتاح سري PORTAL_SECRET
 *   (خصائص السكربت ← Script properties).
 * - الشيت يبقى الأساس: القراءة والكتابة على نفس التبويبات.
 * - الكتابة تستدعي onEditHandlerLocked_ نفسها، فيصير بالضبط مثل تعديل الموظف
 *   داخل الشيت (النسخ لسجل الرسائل، تاريخ الحالة، الإخفاء بعد 24 ساعة، SLA والتلوين).
 * - بدون أي مشغّل جديد. القراءة مخزنة مؤقتاً 60 ثانية لتخفيف الضغط.
 ********************************************************/
const PORTAL_API = {
  CACHE_LIST: 'portal_list_v1',
  CACHE_SEC: 60,
  STATS_SEC: 300,
  TAIL_ROWS: 1000, // يقرأ آخر 1000 صف من كل تبويب فقط (الأقدم منتهٍ ومخفي)
  SERVICE_SHEETS: ['تجديد الموعد', 'تعديل الموعد', 'إلغاء الموعد', 'الاستعلام عن موعد']
};

function doPost(e) {
  const out = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { req = {}; }
  const secret = PropertiesService.getScriptProperties().getProperty('PORTAL_SECRET');
  if (!secret || String(req.secret || '') !== secret) return out({ ok: false, error: 'unauthorized' });
  try {
    if (req.action === 'list') {
      const data = portalList_();
      data.me = req.actor ? portalActor_(req.actor) : '';
      return out({ ok: true, data: data });
    }
    if (req.action === 'update') return out({ ok: true, data: portalUpdate_(req) });
    if (req.action === 'msg') return out({ ok: true, data: portalMsg_(req) });
    if (req.action === 'search') return out({ ok: true, data: portalSearch_(req) });
    if (req.action === 'stats') return out({ ok: true, data: portalStats_(req) });
    return out({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.log('portal ' + req.action + ': ' + (err && err.stack || err));
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function portalZip_(text) {
  return Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(text, 'application/json')).getBytes());
}
function portalUnzip_(b64) {
  return Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip')).getDataAsString('UTF-8');
}

/* أرقام الأعمدة المطابقة لأي من الأسماء، بتجاهل الحروف المخفية والمسافات الزائدة */
function portalNormH_(h) {
  return String(h || '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u00A0\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();
}
function portalCols_(headers, names) {
  const want = names.map(portalNormH_);
  const out = [];
  want.forEach(w => headers.forEach((h, i) => { if (portalNormH_(h) === w && out.indexOf(i + 1) === -1) out.push(i + 1); }));
  return out;
}

function portalVal_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  return v === null || v === undefined ? '' : v;
}

/* يقرأ آخر صفوف التبويب مع رقم الصف الحقيقي */
function portalTail_(sh) {
  const last = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  if (last < 2) return { headers: headers, start: 2, data: [] };
  const start = Math.max(2, last - PORTAL_API.TAIL_ROWS + 1);
  return { headers: headers, start: start, data: sh.getRange(start, 1, last - start + 1, lastCol).getValues() };
}

function portalList_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(PORTAL_API.CACHE_LIST);
  if (hit) return JSON.parse(portalUnzip_(hit));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hidden = getHiddenMap_(ss);
  const now = Date.now();
  const delayMs = OPD.HIDE_DELAY_HOURS * 36e5;
  const res = { at: new Date().toISOString(), statuses: OPD.STATUS_LIST,
                msgStatuses: OPD.MESSAGE_STATUS_LIST, services: {}, noteOptions: {}, clinics: [], messages: [] };
  const clinicSet = {};

  PORTAL_API.SERVICE_SHEETS.forEach(name => {
    const sh = ss.getSheetByName(name);
    const rows = [];
    if (sh) {
      const t = portalTail_(sh);
      const hid = hidden ? (hidden[name] || []) : null;
      const c = n => findColTrim_(t.headers, n);
      const cs = (...names) => portalCols_(t.headers, names);
      const col = {
        ts: c('طابع زمني'), service: c('نوع الخدمة'), noShow: c('سبب عدم الحضور'),
        name: c('الإسم رباعي'), nid: c('رقم الهوية'), dob: c('تاريخ الميلاد'), mobile: c('رقم الجوال'),
        clinic: c('العيادة'), period: c('الفترة'), doctor: c('الطبيب'),
        status: c('حالة الطلب'), employee: c('اسم الموظف'), staffNote: c('ملاحظات موظف الاستقبال'),
        raw: c(OPD.TECH_RAW_ROW), changed: c(OPD.TECH_STATUS_CHANGED_AT)
      };
      // أعمدة أسماؤها تختلف بين التبويبات (حروف مخفية أو اسم مختصر): نقرأ أول قيمة غير فارغة
      const multi = {
        purpose: cs('الغرض من التعديل'),
        notes: cs('ملاحظات أو طلبات خاصة', 'ملاحظات'),
        apptDate: cs('تاريخ الموعد المراد تعديله', 'تاريخ الموعد المراد إلغاؤه', 'تاريخ الموعد')
      };
      if (!col.noShow) col.noShow = portalCols_(t.headers, ['سبب عدم الحضور'])[0] || 0;
      t.data.forEach((r, i) => {
        const rowNo = t.start + i;
        if (!col.ts || !hasValue_(r[col.ts - 1])) return;
        if (col.clinic) { const cl = String(r[col.clinic - 1] || '').trim(); if (cl && cl.length <= 60) clinicSet[cl] = 1; }
        if (hid ? !!hid[rowNo - 1] : (col.changed && isExpired_(r[col.changed - 1], now, delayMs))) return;
        const g = k => (col[k] ? portalVal_(r[col[k] - 1]) : '');
        const gm = k => { for (const ci of multi[k]) { const v = portalVal_(r[ci - 1]); if (hasValue_(v)) return v; } return ''; };
        rows.push({
          row: rowNo, raw: g('raw'), ts: g('ts'), service: g('service'),
          reason: g('noShow') || gm('purpose'), name: g('name'), nid: String(g('nid')).replace(/^'/, ''),
          dob: String(g('dob')).replace(/^'/, ''), mobile: g('mobile'), clinic: g('clinic'), period: g('period'),
          apptDate: gm('apptDate'), doctor: g('doctor'), notes: gm('notes'),
          status: String(g('status')).trim(), employee: g('employee'), staffNote: g('staffNote'), changed: g('changed')
        });
      });
    }
    res.services[name] = rows;
    res.noteOptions[name] = sh ? portalNoteOptions_(sh) : [];
  });

  const msg = ss.getSheetByName(OPD.SHEET_MESSAGES);
  if (msg) {
    const t = portalTail_(msg);
    const hid = hidden ? (hidden[OPD.SHEET_MESSAGES] || []) : null;
    const c = n => findColTrim_(t.headers, n);
    const col = {
      copied: c('تاريخ النسخ إلى سجل الرسائل'), ts: c('طابع زمني'), name: c('الإسم رباعي'), mobile: c('رقم الجوال'),
      clinic: c('العيادة'), note: c('ملاحظات موظف الاستقبال'), status: c('حالة الرسالة'), employee: c('اسم الموظف'),
      sentAt: c(OPD_ALERT.MSG_SENT_AT), sla: c(OPD_ALERT.MSG_SLA), key: c(OPD.TECH_MESSAGE_KEY)
    };
    t.data.forEach((r, i) => {
      const rowNo = t.start + i;
      if (!col.copied || !hasValue_(r[col.copied - 1])) return;
      if (hid && hid[rowNo - 1]) return;
      const g = k => (col[k] ? portalVal_(r[col[k] - 1]) : '');
      const status = String(g('status')).trim();
      if (!hid && status === 'تم' && col.sentAt && isExpired_(r[col.sentAt - 1], now, delayMs)) return;
      const key = String(g('key'));
      const phone = normalizeSaMobile_(g('mobile'));
      const note = String(g('note')).trim();
      res.messages.push({
        row: rowNo, key: key, copied: g('copied'), ts: g('ts'), name: g('name'), mobile: g('mobile'),
        clinic: g('clinic'), note: note, status: status, employee: g('employee'), sentAt: g('sentAt'), sla: g('sla'),
        service: key.split('#')[0],
        phone: phone, badPhone: !!note && !phone
      });
    });
  }

  res.clinics = Object.keys(clinicSet).sort((a, b) => a.localeCompare(b, 'ar'));
  const packed = portalZip_(JSON.stringify(res));
  if (packed.length < 95000) cache.put(PORTAL_API.CACHE_LIST, packed, PORTAL_API.CACHE_SEC);
  return res;
}

/* نفس منطق التعديل اليدوي في الشيت (onEditHandlerLocked_) */
function portalRunEdit_(range, value) {
  try {
    onEditHandlerLocked_({ range: range, value: value });
  } catch (err) {
    // رسائل toast لا تعمل خارج الشيت؛ أي خطأ آخر يُسجَّل ويُبلَّغ
    if (String(err).indexOf('toast') === -1) throw err;
  }
}

/* قائمة «ملاحظات موظف الاستقبال» من إعدادات الشيت نفسه (التحقق من صحة البيانات) — بدون كتابة الصيغ في الكود */
const PORTAL_APPT_PREFIX = 'موعدكم في عيادة ';
const PORTAL_NO_APPT = 'لا يوجد موعد';
/* صيغة الاستعلام الموحدة: «موعدكم في عيادة X يوم <الأحد..الخميس> dd/mm/yyyy الساعة h:mm ص|م» من 7:30 ص إلى 7:30 م */
function portalApptOk_(note) {
  const m = String(note).match(/^موعدكم في عيادة (.{2,60}) يوم (الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس) (\d{2})\/(\d{2})\/(\d{4}) الساعة (\d{1,2}):(\d{2}) (ص|م)$/);
  if (!m) return false;
  let h = Number(m[6]) % 12; if (m[8] === 'م') h += 12;
  const mins = h * 60 + Number(m[7]);
  return mins >= 450 && mins <= 1170;
}
function portalNoteOptions_(sh) {
  try {
    const col = findColTrim_(getHeaders_(sh), 'ملاحظات موظف الاستقبال');
    if (!col) return [];
    let dv = sh.getRange(2, col).getDataValidation();
    if (!dv && sh.getLastRow() > 2) dv = sh.getRange(sh.getLastRow(), col).getDataValidation();
    if (!dv) return [];
    const type = dv.getCriteriaType(), vals = dv.getCriteriaValues();
    let list = [];
    if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) list = vals[0] || [];
    else if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) list = vals[0].getValues().reduce((a, r) => a.concat(r), []);
    return list.map(v => String(v).trim()).filter(Boolean);
  } catch (err) {
    console.log('noteOptions ' + sh.getName() + ': ' + err);
    return [];
  }
}

function portalClean_(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 500);
}

/* اسم الموظف = صاحب الحساب في المنصة (يرسله Supabase من الخادم، لا يختاره الموظف).
   يُطابَق مع قائمة أسماء الشيت لتبقى الصيغة نفسها في الإحصائية؛ وإن لم يطابق يُكتب كما هو. */
function portalActor_(actor) {
  const name = portalClean_(actor, 80);
  if (!name) throw new Error('تعذر تحديد اسم الموظف من الحساب');
  const key = compact_(name);
  const exact = OPD.EMPLOYEES.filter(e => compact_(e) === key);
  if (exact.length === 1) return exact[0];
  const toks = normalize_(name).split(' ').filter(Boolean);
  if (toks.length >= 2) {
    const first = toks[0], last = toks[toks.length - 1];
    const hit = OPD.EMPLOYEES.filter(e => {
      const t = normalize_(e).split(' ').filter(Boolean);
      return t[0] === first && t[t.length - 1] === last;
    });
    if (hit.length === 1) return hit[0];
  }
  return name;
}

/* تحديث طلب في تبويب الخدمة: الحالة + اسم الموظف + ملاحظات موظف الاستقبال */
function portalUpdate_(req) {
  const name = String(req.sheet || '');
  if (PORTAL_API.SERVICE_SHEETS.indexOf(name) === -1) throw new Error('تبويب غير معروف');
  const status = portalClean_(req.status, 20);
  if (status && OPD.STATUS_LIST.indexOf(status) === -1) throw new Error('حالة غير صحيحة');
  const employee = portalActor_(req.actor);
  const note = portalClean_(req.staffNote, 500);
  const row = Number(req.row);
  if (!(row >= 2)) throw new Error('رقم الصف غير صحيح');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('الشيت مشغول، حاول بعد لحظات');
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(name);
    // الملاحظة من القائمة فقط (نفس قائمة الشيت)، والاستعلام يقبل أيضاً صيغة الموعد الموحدة
    const options = sh ? portalNoteOptions_(sh) : [];
    const isInquiry = name === OPD.SHEET_INQUIRY;
    const apptOk = isInquiry && (note === PORTAL_NO_APPT || portalApptOk_(note));
    const writeNote = options.length > 0 || isInquiry;
    const noteCol = sh ? findColTrim_(getHeaders_(sh), 'ملاحظات موظف الاستقبال') : 0;
    const current = noteCol && row <= sh.getLastRow() ? portalClean_(sh.getRange(row, noteCol).getValue(), 500) : '';
    if (note && writeNote && options.indexOf(note) === -1 && !apptOk && note !== current) throw new Error('اختر الملاحظة من القائمة');
    if (!sh || row > sh.getLastRow()) throw new Error('الطلب غير موجود');
    const h = getHeaders_(sh);
    const rawCol = getHeaderCol_(h, OPD.TECH_RAW_ROW);
    if (rawCol && hasValue_(req.raw) && String(sh.getRange(row, rawCol).getValue()).trim() !== String(req.raw).trim()) {
      throw new Error('تغيّر ترتيب الصفوف في الشيت، حدّث الصفحة ثم أعد المحاولة');
    }
    const sC = getHeaderCol_(h, 'حالة الطلب');
    const eC = getHeaderCol_(h, 'اسم الموظف');
    const nC = getHeaderCol_(h, 'ملاحظات موظف الاستقبال');
    if (eC) sh.getRange(row, eC).setValue(employee);
    if (nC && writeNote) sh.getRange(row, nC).setValue(note);
    if (sC) sh.getRange(row, sC).setValue(status);
    SpreadsheetApp.flush();
    portalRunEdit_(sh.getRange(row, sC || 1), status);
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove(PORTAL_API.CACHE_LIST);
  return { saved: true };
}

/* تحديث حالة رسالة في سجل الرسائل */
function portalMsg_(req) {
  const status = portalClean_(req.status, 80);
  if (status && OPD.MESSAGE_STATUS_LIST.indexOf(status) === -1) throw new Error('حالة غير صحيحة');
  const employee = portalActor_(req.actor);
  const row = Number(req.row);
  if (!(row >= 2)) throw new Error('رقم الصف غير صحيح');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('الشيت مشغول، حاول بعد لحظات');
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(OPD.SHEET_MESSAGES);
    if (!sh || row > sh.getLastRow()) throw new Error('الرسالة غير موجودة');
    const h = getHeaders_(sh);
    const kC = getHeaderCol_(h, OPD.TECH_MESSAGE_KEY);
    if (kC && hasValue_(req.key) && String(sh.getRange(row, kC).getValue()).trim() !== String(req.key).trim()) {
      throw new Error('تغيّر ترتيب الصفوف في الشيت، حدّث الصفحة ثم أعد المحاولة');
    }
    const sC = getHeaderCol_(h, 'حالة الرسالة');
    const eC = getHeaderCol_(h, 'اسم الموظف');
    if (!sC) throw new Error('عمود حالة الرسالة غير موجود');
    if (eC) sh.getRange(row, eC).setValue(employee);
    sh.getRange(row, sC).setValue(status);
    SpreadsheetApp.flush();
    portalRunEdit_(sh.getRange(row, sC), status);
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove(PORTAL_API.CACHE_LIST);
  return { saved: true };
}

/* البحث برقم الهوية: نفس دالة تبويب «بحث» */
function portalSearch_(req) {
  const id = String(req.nid || '').trim();
  if (!/^\d{10}$/.test(id)) throw new Error('رقم الهوية 10 أرقام');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return searchByNationalId_(ss, id)
    .map(r => ({ source: r.source, fullName: portalVal_(r.fullName), clinic: portalVal_(r.clinic), doctor: portalVal_(r.doctor),
                 timestamp: portalVal_(r.timestamp), status: portalVal_(r.status), employee: portalVal_(r.employee), notes: portalVal_(r.notes) }))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

/* الإحصائية والمؤشرات: نفس collectDashboardData_ لفترة يختارها الموظف (بدون الكتابة في التبويبات) */
function portalStats_(req) {
  const parse = s => {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : '';
  };
  const from = parse(req.from), to = parse(req.to);
  const key = 'portal_stats_' + (req.from || '') + '_' + (req.to || '');
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // تسريع لهذا التنفيذ فقط: نفس منطق isHiddenFast_ لكن بدون استدعاء getName() لكل صف
  const names = new Map();
  isHiddenFast_ = function (map, sheet, row) {
    let n = names.get(sheet);
    if (n === undefined) { n = sheet.getName(); names.set(sheet, n); }
    return map && map[n] ? !!map[n][row - 1] : false;
  };
  const d = collectDashboardData_(ss, from, to);
  const avg = d.closeHours.length ? Math.round(d.closeHours.reduce((a, b) => a + b, 0) / d.closeHours.length * 10) / 10 : null;
  const notes = Object.keys(d.notes).map(k => [k, d.notes[k]]).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const res = {
    from: req.from || '', to: req.to || '', at: new Date().toISOString(),
    total: d.total, renew: d.renew, modify: d.modify, cancel: d.cancel, done: d.done, notDone: d.notDone,
    hiddenNoStatus: d.hiddenNoStatus, pending: d.pending, overdue: d.overdue, avgCloseHours: avg,
    msgSent: d.msgSent, msgFail: d.msgFail, msgPending: d.msgPending,
    employees: Object.keys(d.employees).map(k => [k, d.employees[k].total, d.employees[k].done, d.employees[k].notDone]).sort((a, b) => b[1] - a[1]),
    noShow: Object.keys(d.noShow).map(k => [k, d.noShow[k].count, d.noShow[k].tag]).sort((a, b) => b[1] - a[1]),
    notes: notes
  };
  const json = JSON.stringify(res);
  if (json.length < 95000) cache.put(key, json, PORTAL_API.STATS_SEC);
  return res;
}

/* تشغيل لمرة واحدة من المحرر: يولّد المفتاح السري ويحفظه هنا، ويسجّله في Supabase
   (يقبل Supabase التسجيل مرة واحدة فقط؛ لإعادة التوليد احذف السطر من opd_eservices_link أولاً). */
function setupPortalApi() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('PORTAL_SECRET');
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('PORTAL_SECRET', secret);
  }
  const res = UrlFetchApp.fetch('https://omugonzzrulsdpnycact.supabase.co/rest/v1/rpc/opd_eservices_register', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: 'sb_publishable_f3IjPvIbMruO9jGb4SmT7Q_NOqgEbXs' },
    payload: JSON.stringify({ p_secret: secret })
  });
  console.log('register: ' + res.getResponseCode() + ' ' + res.getContentText());
}
