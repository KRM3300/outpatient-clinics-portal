/**
 * ربط شيت «حجز مواعيد للمستشفيات التابعة» بطلبات الحجز الموحّدة في المنصة.
 * ملف Affiliate.gs داخل مشروع «OPD Drive Sync» (نفس الحساب المالك للشيت).
 *
 * - كل رد جديد من نموذج Google ينتقل تلقائياً لقائمة «معالجة الطلبات» (عند الإرسال مباشرة).
 * - احتياط: مراجعة يومية قرابة 5:30 فجراً تلتقط أي رد فات.
 * - لا يُكتب شيء في الشيت، ولا يُرسل عمود «الرقم السري للطبيب» أبداً.
 * - منع التكرار يتم في المنصة (نفس المراجع ونفس وقت الطلب).
 *
 * التشغيل لأول مرة: شغّل affiliateSetup() مرة واحدة من المحرر.
 * يولّد السر داخل السكربت ويسجله في المنصة (لا يُكتب في أي ملف)، ثم ينشئ المشغّلات وينقل الطلبات الحالية.
 */
const AFFILIATE = Object.freeze({
  SHEET_ID: '10xxYLHXkW7S7IXaMhhMeGTUHWRVc3iusaKaUsV2jSmM',
  SHEET_GID: 2127100498, // تبويب «الردود»
  RPC: 'https://omugonzzrulsdpnycact.supabase.co/rest/v1/rpc/',
  SECRET_PROP: 'AFFILIATE_SYNC_SECRET',
  CLINICS: ['Anesthesia', 'Chest', 'Infectious disease', 'Hematology', 'Pediatric', 'Dev. & Beh. Disorder', 'Newborn',
    'Physical Medicine & Rehabilitation', 'Neurosurgery', 'Psychiatric', 'Gastroenterology', 'OB/Gyn', 'Medical',
    'Cardiology', 'Minor Surgery', 'Pediatric Surgery', 'Surgery', 'Urology', 'Orthopedic', 'Optometry', 'Ophthalmology',
    'Audiology', 'ENT', 'Psychotherapy', 'Dermatology', 'Nephrology', 'Neurology', 'Rheumatology', 'Plastic Surgery',
    'Endocrinology'],
  ALIASES: {
    endocrine: 'Endocrinology', endocrinology: 'Endocrinology', 'غدد': 'Endocrinology',
    'neuro surgery': 'Neurosurgery', 'جراحة المخ': 'Neurosurgery',
    ortho: 'Orthopedic', orthopedics: 'Orthopedic', 'العظام': 'Orthopedic',
    obgyn: 'OB/Gyn', 'ob gyn': 'OB/Gyn', gynecology: 'OB/Gyn', 'النساء': 'OB/Gyn',
    'internal medicine': 'Medical', 'الباطنة': 'Medical', 'الباطنية': 'Medical',
    pediatrics: 'Pediatric', 'الأطفال': 'Pediatric',
    psychiatry: 'Psychiatric', 'النفسي': 'Psychiatric',
    'general surgery': 'Surgery', 'الجراحة': 'Surgery',
    'المسالك': 'Urology', 'الجلدية': 'Dermatology', 'الكلى': 'Nephrology', 'الأعصاب': 'Neurology',
    'الروماتيزم': 'Rheumatology', 'القلب': 'Cardiology', 'الصدرية': 'Chest', 'الهضمي': 'Gastroenterology',
    'العيون': 'Ophthalmology', 'السمعيات': 'Audiology', 'الأنف': 'ENT', 'الدم': 'Hematology',
  },
});

function affiliateSetup() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(AFFILIATE.SECRET_PROP);
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    const ok = affiliateRpc_('opd_booking_ingest_register', { p_secret: secret });
    if (ok !== true) throw new Error('السر مسجّل مسبقاً في المنصة لسكربت آخر — راجع opd_sync_secrets (affiliate_sync).');
    props.setProperty(AFFILIATE.SECRET_PROP, secret);
  }
  ScriptApp.getProjectTriggers()
    .filter(t => ['affiliateOnSubmit', 'affiliateSync'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('affiliateOnSubmit').forSpreadsheet(AFFILIATE.SHEET_ID).onFormSubmit().create();
  ScriptApp.newTrigger('affiliateSync').timeBased().everyDays(1).atHour(5).nearMinute(30)
    .inTimezone(DRIVE_SYNC.ZONE).create();
  Logger.log('تم إعداد الربط: عند كل إرسال للنموذج + مراجعة يومية 5:30 ص.');
  affiliateSync();
}

function affiliateOnSubmit() {
  Utilities.sleep(3000); // ننتظر حتى يكتمل الصف في الشيت
  affiliateSync();
}

function affiliateSync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const secret = PropertiesService.getScriptProperties().getProperty(AFFILIATE.SECRET_PROP);
    if (!secret) throw new Error('شغّل affiliateSetup() أولاً.');
    const ss = SpreadsheetApp.openById(AFFILIATE.SHEET_ID);
    const sh = ss.getSheets().find(s => s.getSheetId() === AFFILIATE.SHEET_GID);
    if (!sh || sh.getLastRow() < 2) return;
    const values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    const head = values[0].map(h => String(h || '').replace(/\s+/g, ' ').trim());
    const col = (...keys) => head.findIndex(h => keys.some(k => h.indexOf(k) === 0));
    const c = {
      ts: col('طابع زمني'), name: col('اسم المراجع'), id: col('رقم الهوية'), dob: col('تاريخ الميلاد'),
      mother: col('اسم الام', 'اسم الأم'), mobile: col('رقم الجوال'), hospital: col('اسم المستشفى'),
      clinic: col('العيادة'), doctor: col('اسم الطبيب'), status: col('حالة الطلب'),
    };
    ['ts', 'name', 'id', 'clinic'].forEach(k => { if (c[k] < 0) throw new Error('عمود غير موجود في الشيت: ' + k); });

    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (!(r[c.ts] instanceof Date)) continue;
      if (r[c.ts] < new Date('2026-11-16T00:00:00+03:00')) continue; // ما قبله محفوظ كسجل تاريخي في المنصة
      if (c.status >= 0 && String(r[c.status] || '').trim()) continue; // عولج في الشيت نفسه
      const clinic = affiliateClinic_(r[c.clinic]);
      rows.push({
        ts: r[c.ts].toISOString(),
        patient_name: String(r[c.name] || '').trim(),
        patient_identifier: String(r[c.id] || '').replace(/\D/g, ''),
        patient_dob: c.dob >= 0 && r[c.dob] instanceof Date
          ? Utilities.formatDate(r[c.dob], DRIVE_SYNC.ZONE, 'yyyy-MM-dd') : '',
        mother_name: c.mother >= 0 ? String(r[c.mother] || '').trim() : '',
        patient_mobile: c.mobile >= 0 ? String(r[c.mobile] || '').replace(/[^\d+]/g, '') : '',
        source_facility: c.hospital >= 0 ? String(r[c.hospital] || '').trim() : '',
        clinic_name: clinic.name,
        clinic_manual: clinic.manual,
        referring_doctor: c.doctor >= 0 ? String(r[c.doctor] || '').trim() : '',
      });
    }
    if (!rows.length) return;
    const res = affiliateRpc_('opd_booking_ingest', { p_secret: secret, p_rows: rows });
    if (!res || res.ok !== true) throw new Error('رفضت المنصة الإرسال: ' + JSON.stringify(res));
    Logger.log('المستشفيات التابعة: أُضيف ' + res.added + '، تجاوز (موجود مسبقاً) ' + res.skipped);
  } catch (e) {
    try {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'تعذّر ربط طلبات المستشفيات التابعة بالمنصة',
        'الخطأ: ' + (e && e.message ? e.message : e) + '\nالطلبات ما زالت في الشيت ولم تُفقد. يعاد المحاولة مع الإرسال القادم أو المراجعة اليومية.');
    } catch (_) {}
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function affiliateClinic_(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { name: 'غير محددة', manual: true };
  const lower = text.toLowerCase();
  const latin = (text.match(/[A-Za-z][A-Za-z .&\/-]*/g) || []).map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const l of latin) {
    const exact = AFFILIATE.CLINICS.find(x => x.toLowerCase() === l);
    if (exact) return { name: exact, manual: false };
    if (AFFILIATE.ALIASES[l]) return { name: AFFILIATE.ALIASES[l], manual: false };
  }
  for (const k of Object.keys(AFFILIATE.ALIASES)) {
    if (lower.indexOf(k) >= 0) return { name: AFFILIATE.ALIASES[k], manual: false };
  }
  return { name: text.slice(0, 120), manual: true }; // يظهر تنبيه «إدخال يدوي» للمراجعة
}

function affiliateRpc_(fn, body) {
  const res = UrlFetchApp.fetch(AFFILIATE.RPC + fn, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: DRIVE_SYNC.PUBLIC_KEY, Authorization: 'Bearer ' + DRIVE_SYNC.PUBLIC_KEY },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const txt = res.getContentText();
  if (code >= 300) throw new Error('HTTP ' + code + ': ' + txt.slice(0, 300));
  return JSON.parse(txt);
}
