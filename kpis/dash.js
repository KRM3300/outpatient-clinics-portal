/* لوحة اتجاه المؤشرات — تقرأ أرقام التقارير المحفوظة في المنصة وتجمعها لأي فترة يختارها المستخدم.
   لا تحتوي بيانات مرضى: أرقام مجمّعة فقط. */
(() => {
  const $ = (id) => document.getElementById(id);
  const node = (t, text, cls) => {
    const e = document.createElement(t);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const SVG = "http://www.w3.org/2000/svg";
  const svg = (t, a) => {
    const e = document.createElementNS(SVG, t);
    for (const k in a) e.setAttribute(k, a[k]);
    return e;
  };

  /* ---------- التواريخ ---------- */
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const D = (s) => new Date(s + "T12:00:00");
  const add = (s, n) => { const d = D(s); d.setDate(d.getDate() + n); return iso(d); };
  const span = (a, b) => Math.round((D(b) - D(a)) / 864e5) + 1;
  const fmt = (s) => s.slice(8, 10) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4);
  const fmtShort = (s) => s.slice(8, 10) + "/" + s.slice(5, 7);
  const shiftYear = (s, n) => { const d = D(s); d.setFullYear(d.getFullYear() + n); return iso(d); };
  const today = () => iso(new Date());

  /* ---------- قراءة أرقام التقرير (الحديثة من metrics، والقديمة من سطور الملخص) ---------- */
  const num = (v) => {
    if (v == null) return null;
    const m = String(v).replace(/[٠-٩]/g, (c) => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    return m ? +m[0] : null;
  };
  function metricsOf(r) {
    const s = r.summary || {};
    if (s.metrics) return s.metrics;
    const it = Object.fromEntries((s.items || []).map(([k, v]) => [k.trim(), v]));
    const find = (re) => { for (const k in it) if (re.test(k)) return it[k]; return null; };
    if (r.report_type.startsWith("reverse")) {
      const inc = num(find(/الواردة/)), out = num(find(/الصادرة/));
      return { incoming: inc, outgoing: out, ratio: inc ? Math.round((out / inc) * 1000) / 10 : null };
    }
    if (r.report_type === "referrals_daily") {
      const ov = find(/التجاوز/) || "";
      const m = String(ov).match(/(\d+)\D+(\d+)/);
      return { waiting: num(find(/قائمة الانتظار/)), overdue: m ? +m[1] : num(ov), booked: m ? +m[2] : null, warn14: num(find(/الإنذار/)), compliance: num(find(/الالتزام/)) };
    }
    if (r.report_type === "adaa_weekly") {
      return { appointments: num(find(/إجمالي المواعيد|^المواعيد/)), visits: num(find(/المعاينات/)), attendance: num(find(/^الحضور/)), noshow: num(find(/عدم الحضور/)), seen30: num(find(/30/)), within14: num(find(/14/)), ontime: num(find(/في وقتها/)), unclosed: num(find(/لم تُ?غلق/)) };
    }
    return {};
  }

  /* ---------- تعريف المؤشرات ---------- */
  // good: 1 = الأعلى أفضل، -1 = الأقل أفضل، 0 = محايد. pct = نسبة مئوية (الفرق بالنقاط)
  const IND = {
    reverse: {
      label: "الإحالة العكسية",
      types: ["reverse_daily", "reverse_weekly"],
      metrics: [
        { k: "ratio", l: "مؤشر التجمع (الصادرة ÷ الواردة)", pct: true, good: 1, target: 10 },
        { k: "outgoing", l: "الإحالات الصادرة (العكسية)", good: 1 },
        { k: "incoming", l: "الإحالات الواردة من المراكز", good: 0 },
      ],
    },
    referrals: {
      label: "الإحالات الواردة والزمن المعياري",
      types: ["referrals_daily"],
      metrics: [
        { k: "compliance", l: "الالتزام بالزمن المعياري", pct: true, good: 1 },
        { k: "overdue", l: "التجاوز الفعلي (مواعيد خارج الزمن)", good: -1 },
        { k: "warn14", l: "الإنذار المبكر (14 يوماً فأكثر)", good: -1 },
        { k: "urgent5", l: "العاجلة المحجوزة خلال 5 أيام", pct: true, good: 1 },
        { k: "routine28", l: "الروتينية (حالات جديدة من المراكز) خلال 28 يوماً", pct: true, good: 1 },
        { k: "urgent_total", l: "عدد الإحالات العاجلة", good: 0 },
        { k: "booked", l: "المواعيد المحجوزة من المراكز", good: 0 },
        { k: "waiting", l: "قائمة الانتظار (آخر قيمة)", good: -1, last: true },
      ],
    },
    adaa: {
      label: "مؤشرات العيادات (أداء)",
      types: ["adaa_weekly"],
      metrics: [
        { k: "attendance", l: "نسبة الحضور", pct: true, good: 1, avg: true },
        { k: "noshow", l: "نسبة عدم الحضور", pct: true, good: -1, avg: true },
        { k: "seen30", l: "رؤية الطبيب خلال 30 دقيقة", pct: true, good: 1, avg: true },
        { k: "within14", l: "مواعيد خلال 14 يوماً", pct: true, good: 1, avg: true },
        { k: "ontime", l: "فترات بدأت في وقتها", pct: true, good: 1, avg: true },
        { k: "unclosed", l: "زيارات لم تُغلق", good: -1 },
        { k: "appointments", l: "إجمالي المواعيد", good: 0 },
      ],
    },
    rooms: {
      label: "إشغال غرف العيادات (الجدول الأسبوعي)",
      kind: "schedule",
      weekly: true,
      metrics: [
        { k: "occupancy", l: "نسبة إشغال الفترات (المستخدمة ÷ المتاحة)", pct: true, good: 1 },
        { k: "used", l: "الفترات المستخدمة أسبوعياً", good: 1, avg: true },
        { k: "avail", l: "الفترات الشاغرة أسبوعياً", good: -1, avg: true },
        { k: "rooms", l: "عدد غرف العيادات", good: 0, avg: true },
        { k: "slots", l: "إجمالي السلوتات أسبوعياً", good: 1, avg: true },
        { k: "newShare", l: "نسبة سلوتات الزيارة الجديدة", pct: true, good: 0 },
      ],
    },
    nextAvail: {
      label: "أقرب موعد متاح (جاري العمل عليه)",
      soon: true,
      metrics: [{ k: "x", l: "أقرب موعد زيارة جديدة / متابعة لكل تخصص" }],
    },
    requests: {
      label: "طلبات تجديد وتعديل المواعيد",
      kind: "requests",
      metrics: [
        { k: "total", l: "إجمالي الطلبات", good: 0 },
        { k: "renew", l: "طلبات التجديد (بعد عدم الحضور)", good: -1 },
        { k: "modify", l: "طلبات التعديل", good: -1 },
        { k: "cancel", l: "طلبات الإلغاء", good: 0 },
      ],
    },
    satisfaction: {
      label: "رضا المرضى (القياس الداخلي)",
      kind: "satisfaction",
      monthly: true,
      metrics: [
        { k: "overall", l: "نسبة الرضا العامة (ممتاز وجيد جداً)", pct: true, good: 1 },
        { k: "reception", l: "الاستقبال", pct: true, good: 1 },
        { k: "nursing", l: "التمريض", pct: true, good: 1 },
        { k: "doctor", l: "الطبيب", pct: true, good: 1 },
        { k: "pharmacy", l: "الصيدلية", pct: true, good: 1 },
        { k: "facility", l: "المبنى والمرافق", pct: true, good: 1 },
        { k: "n", l: "عدد الاستبيانات", good: 0 },
      ],
    },
  };
  const AXES = ["reception", "nursing", "doctor", "pharmacy", "facility"];
  const kindRows = (k) => ROWS.filter((r) => (r.summary || {}).kind === k);
  const monthEnd = (mo) => { const d = D(mo + "-01"); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };

  /* ---------- تجميع البيانات لفترة ---------- */
  let ROWS = [];
  // الإحالة العكسية: قيمة كل يوم من أحدث تقرير يغطيه (التقارير اليومية تراكمية)
  function reverseDays() {
    const pick = {};
    const reps = ROWS.filter((r) => IND.reverse.types.includes(r.report_type)).sort((a, b) => (a.period_to < b.period_to ? -1 : a.period_to > b.period_to ? 1 : a.created_at < b.created_at ? -1 : 1));
    for (const r of reps) {
      const s = r.summary || {};
      if (Array.isArray(s.days) && s.days.length) {
        for (const d of s.days) pick[d.d] = { in: d.in, out: d.out, rep: r };
      } else if (r.period_from === r.period_to) {
        const m = metricsOf(r);
        pick[r.period_to] = { in: m.incoming, out: m.outgoing, rep: r };
      }
    }
    return pick;
  }
  function deptDaysFor(day, rep) {
    return ((rep.summary || {}).deptDays || []).filter((x) => x.d === day);
  }

  function seriesPoints(ind, a, b) {
    // نقاط يومية (أو لكل تقرير) داخل الفترة: [{d, m:{...}}]
    if (ind === "reverse") {
      const days = reverseDays(), pts = [];
      for (let d = a; d <= b; d = add(d, 1)) if (days[d]) pts.push({ d, m: { incoming: days[d].in, outgoing: days[d].out }, rep: days[d].rep });
      return pts;
    }
    if (ind === "requests") {
      const pts = [];
      for (const r of kindRows("requests")) for (const x of r.summary.days || []) if (x.d >= a && x.d <= b) pts.push({ d: x.d, m: { renew: x.renew, modify: x.modify, cancel: x.cancel, total: x.renew + x.modify + x.cancel }, rep: r });
      return pts.sort((x, y) => (x.d < y.d ? -1 : 1));
    }
    if (ind === "rooms") {
      return kindRows("schedule").filter((r) => r.period_from <= b && r.period_to >= a)
        .sort((x, y) => (x.period_from < y.period_from ? -1 : 1))
        .map((r) => ({ d: r.period_from, m: r.summary.metrics || {}, rep: r }));
    }
    if (ind === "nextAvail") return [];
    if (ind === "satisfaction") {
      return kindRows("satisfaction").filter((r) => r.period_from <= b && r.period_to >= a)
        .sort((x, y) => (x.period_from < y.period_from ? -1 : 1))
        .map((r) => ({ d: r.period_from, m: r.summary.metrics || {}, rep: r }));
    }
    return ROWS.filter((r) => (IND[ind].types || []).includes(r.report_type) && r.period_to >= a && r.period_to <= b)
      .sort((x, y) => (x.period_to < y.period_to ? -1 : 1))
      .map((r) => ({ d: r.period_to, m: metricsOf(r), rep: r }));
  }

  function aggregate(ind, pts) {
    if (!pts.length) return null;
    const sum = (k) => { let s = 0, n = 0; for (const p of pts) if (p.m[k] != null) { s += p.m[k]; n++; } return n ? s : null; };
    if (ind === "reverse") {
      // المؤشر يُحسب فقط على الأيام اللي فيها الواردة معروفة
      const out = sum("outgoing"), inc = sum("incoming");
      let outK = 0;
      for (const p of pts) if (p.m.incoming != null) outK += p.m.outgoing || 0;
      return { outgoing: out, incoming: inc, ratio: inc ? Math.round((outK / inc) * 1000) / 10 : null };
    }
    if (ind === "referrals") {
      const booked = sum("booked"), overdue = sum("overdue");
      let ok = 0, tot = 0, haveParts = false;
      for (const p of pts) if (p.m.routine_total != null) { haveParts = true; ok += (p.m.routine_ok || 0) + (p.m.urgent_ok || 0); tot += (p.m.routine_total || 0) + (p.m.urgent_total || 0); }
      const compliance = haveParts && tot ? Math.round((ok / tot) * 1000) / 10 : booked && overdue != null ? Math.round(((booked - overdue) / booked) * 1000) / 10 : null;
      const lastWait = [...pts].reverse().find((p) => p.m.waiting != null);
      const ut = sum("urgent_total"), uo = sum("urgent_ok"), rt = sum("routine_total"), ro = sum("routine_ok");
      const pc = (x, y) => (y ? Math.round((x / y) * 1000) / 10 : null);
      return { booked, overdue, warn14: sum("warn14"), compliance, waiting: lastWait ? lastWait.m.waiting : null, urgent5: pc(uo, ut), routine28: pc(ro, rt), urgent_total: ut };
    }
    if (ind === "rooms") {
      const u = sum("used"), v = sum("avail"), sl = sum("slots"), sn = sum("slots_new"), k = pts.length;
      const avg = (x) => (x == null ? null : Math.round(x / k));
      return { occupancy: u + v ? Math.round((u / (u + v)) * 1000) / 10 : null, used: avg(u), avail: avg(v), rooms: avg(sum("rooms")), slots: avg(sl), newShare: sl ? Math.round((sn / sl) * 1000) / 10 : null };
    }
    if (ind === "requests") return { total: sum("total"), renew: sum("renew"), modify: sum("modify"), cancel: sum("cancel") };
    if (ind === "satisfaction") {
      const o = { n: sum("n") };
      let tn = 0, tt = 0;
      for (const a of AXES) { const n = sum(a + "_n"), t = sum(a + "_top") || 0; o[a] = n ? Math.round((t / n) * 1000) / 10 : null; if (n) { tn += n; tt += t; } }
      o.overall = tn ? Math.round((tt / tn) * 1000) / 10 : null;
      return o;
    }
    const o = {};
    for (const mt of IND.adaa.metrics) {
      if (mt.avg) { const v = pts.map((p) => p.m[mt.k]).filter((x) => x != null); o[mt.k] = v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null; }
      else o[mt.k] = sum(mt.k);
    }
    return o;
  }

  // تجميع النقاط في فترات للرسم: يومي حتى 31 يوم، أسبوعي حتى 6 أشهر، وإلا شهري
  function buckets(a, b, monthly) {
    const n = monthly ? 999 : span(a, b), out = [];
    if (n <= 31) { for (let d = a; d <= b; d = add(d, 1)) out.push([d, d]); }
    else if (n <= 186) { for (let d = a; d <= b; d = add(d, 7)) out.push([d, add(d, 6) > b ? b : add(d, 6)]); }
    else {
      let d = a;
      while (d <= b) { const e = D(d); const last = iso(new Date(e.getFullYear(), e.getMonth() + 1, 0)); out.push([d, last > b ? b : last]); d = add(last, 1); }
    }
    return out;
  }
  const unit = (a, b) => { if (IND[st.ind].monthly) return "شهر"; if (IND[st.ind].weekly) return "أسبوع"; const n = span(a, b); return n <= 31 ? "يوم" : n <= 186 ? "أسبوع" : "شهر"; };

  /* ---------- الحالة والفروقات ---------- */
  function status(mt, v) {
    if (mt.target == null || v == null) return null;
    if (v >= mt.target) return ["ok", "✓ محقق"];
    if (v >= mt.target * 0.8) return ["warn", "! قريب من المستهدف"];
    return ["bad", "✕ غير محقق"];
  }
  const show = (mt, v) => (v == null ? "—" : mt.pct ? v.toFixed(1).replace(/\.0$/, "") + "%" : Math.round(v).toLocaleString("en-US"));
  function delta(mt, cur, prev) {
    if (cur == null || prev == null) return null;
    const diff = cur - prev;
    let txt;
    if (mt.pct) txt = (diff > 0 ? "+" : "") + diff.toFixed(1).replace(/\.0$/, "") + " نقطة";
    else txt = prev ? (diff > 0 ? "+" : "") + Math.round((diff / prev) * 100) + "%" : diff > 0 ? "+" + diff : String(diff);
    const dir = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    const tone = !dir || !mt.good ? "flat" : dir === mt.good ? "up" : "down";
    return { txt, arrow: dir > 0 ? "↑" : dir < 0 ? "↓" : "→", tone };
  }

  /* ---------- الحالة العامة للواجهة ---------- */
  const st = { ind: "reverse", metric: "ratio", from: "", to: "", cmp: "prev", preset: "30" };

  function setPreset(p) {
    st.preset = p;
    const t = today();
    if (p === "7") { st.from = add(t, -6); st.to = t; }
    else if (p === "30") { st.from = add(t, -29); st.to = t; }
    else if (p === "month") { st.from = t.slice(0, 8) + "01"; st.to = t; }
    else if (p === "quarter") { const m = Math.floor((+t.slice(5, 7) - 1) / 3) * 3 + 1; st.from = t.slice(0, 5) + String(m).padStart(2, "0") + "-01"; st.to = t; }
    else if (p === "year") { st.from = t.slice(0, 4) + "-01-01"; st.to = t; }
    $("d-from").value = st.from;
    $("d-to").value = st.to;
    for (const b of document.querySelectorAll("#d-presets button")) b.setAttribute("aria-pressed", b.dataset.p === p ? "true" : "false");
  }

  function cmpRange() {
    if (st.cmp === "year") return [shiftYear(st.from, -1), shiftYear(st.to, -1), "نفس الفترة من السنة الماضية"];
    if (st.cmp === "prev") { const n = span(st.from, st.to); return [add(st.from, -n), add(st.from, -1), "الفترة السابقة"]; }
    return null;
  }

  /* ---------- الرسم ---------- */
  function render() {
    const ind = IND[st.ind];
    if (!ind.metrics.some((m) => m.k === st.metric)) st.metric = ind.metrics[0].k;
    const msel = $("d-metric");
    msel.replaceChildren(...ind.metrics.filter((m) => !m.last).map((m) => new Option(m.l, m.k)));
    msel.value = st.metric;

    if (ind.soon) {
      $("d-period").textContent = "";
      $("d-tiles").replaceChildren(node("p", "قيد الإعداد: أقرب موعد زيارة جديدة، وأقرب موعد متابعة، والمتوسط لكل تخصص. سيُضاف هنا أول ما يتحدد مصدر البيانات.", "empty"));
      $("d-chart").replaceChildren(); $("d-legend").replaceChildren(); $("d-chart-title").textContent = ""; $("d-rank-sec").hidden = true;
      return;
    }
    const cr = cmpRange();
    const cur = aggregate(st.ind, seriesPoints(st.ind, st.from, st.to));
    const prev = cr ? aggregate(st.ind, seriesPoints(st.ind, cr[0], cr[1])) : null;
    $("d-period").textContent = "الفترة: " + fmt(st.from) + " – " + fmt(st.to) + (cr ? " · المقارنة مع " + cr[2] + " (" + fmt(cr[0]) + " – " + fmt(cr[1]) + ")" : "");

    /* البطاقات */
    const tiles = $("d-tiles");
    tiles.replaceChildren();
    if (!cur) {
      tiles.append(node("p", "لا توجد تقارير محفوظة لهذه الفترة.", "empty"));
    } else {
      for (const mt of ind.metrics) {
        const v = cur[mt.k];
        if (v == null && (!prev || prev[mt.k] == null)) continue;
        const t = node("article", undefined, "tile-k" + (mt.k === st.metric ? " sel" : ""));
        t.tabIndex = 0;
        t.onclick = () => { if (!mt.last) { st.metric = mt.k; render(); } };
        t.append(node("div", mt.l, "tl"), node("div", show(mt, v), "tv"));
        const s = status(mt, v);
        if (s) t.append(node("span", s[1], "pill " + s[0]));
        if (mt.target != null) t.append(node("div", "المستهدف " + mt.target + "% فأكثر", "tm"));
        if (cr) {
          const dl = delta(mt, v, prev ? prev[mt.k] : null);
          const line = node("div", undefined, "tc");
          if (dl) {
            line.append(node("span", dl.arrow + " " + dl.txt, "dl " + dl.tone), node("span", " مقابل " + show(mt, prev[mt.k])));
          } else line.append(node("span", "لا توجد بيانات للمقارنة"));
          t.append(line);
        }
        tiles.append(t);
      }
    }

    drawChart(cr);
    drawRanking(cr);
  }

  function chartSeries(a, b) {
    if (IND[st.ind].weekly) return seriesPoints(st.ind, a, b).map((p) => ({ a: p.rep.period_from, b: p.rep.period_to, v: aggregate(st.ind, [p])[st.metric] }));
    return buckets(a, b, IND[st.ind].monthly).map(([x, y]) => {
      const ag = aggregate(st.ind, seriesPoints(st.ind, x, y));
      return { a: x, b: y, v: ag ? ag[st.metric] : null };
    });
  }

  function drawChart(cr) {
    const box = $("d-chart");
    box.replaceChildren();
    const mt = IND[st.ind].metrics.find((m) => m.k === st.metric);
    const cur = chartSeries(st.from, st.to);
    const prev = cr ? chartSeries(cr[0], cr[1]) : null;
    $("d-chart-title").textContent = mt.l + " — حسب " + unit(st.from, st.to);
    const vals = cur.map((p) => p.v).concat(prev ? prev.map((p) => p.v) : []).filter((v) => v != null);
    if (!vals.length) { box.append(node("p", "لا توجد بيانات للرسم في هذه الفترة.", "empty")); $("d-legend").replaceChildren(); return; }

    const W = Math.max(300, Math.round(box.clientWidth || 760)), H = W < 500 ? 220 : 260, L = 44, R = 12, T = 22, B = 30;
    const nice = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; };
    let max = Math.max(...vals, mt.target || 0) * 1.08;
    max = max <= 0 ? 1 : nice(max);
    if (mt.pct && max > 100 && Math.max(...vals) <= 100) max = 100;
    const n = cur.length;
    const X = (i) => (n === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (n - 1));
    const Y = (v) => T + (H - T - B) * (1 - v / max);
    const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": mt.l, class: "chart-svg" });

    // شبكة أفقية خفيفة + قيم المحور
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4, y = Y(v);
      g.append(svg("line", { x1: L, x2: W - R, y1: y, y2: y, class: "grid" }));
      const tx = svg("text", { x: L - 8, y: y + 4, class: "ax", "text-anchor": "end" });
      tx.textContent = (Math.round(v * 10) / 10).toLocaleString("en-US") + (mt.pct ? "%" : "");
      g.append(tx);
    }
    // المستهدف
    if (mt.target != null) {
      const y = Y(mt.target);
      g.append(svg("line", { x1: L, x2: W - R, y1: y, y2: y, class: "target" }));
      const tx = svg("text", { x: L + 4, y: y - 6, class: "ax tgt", "text-anchor": "end", direction: "rtl" });
      tx.textContent = "المستهدف " + mt.target + "%";
      g.append(tx);
    }
    // تسميات المحور الأفقي (بحد أقصى 8)
    const step = Math.max(1, Math.ceil(n / (W < 500 ? 4 : 8)));
    cur.forEach((p, i) => {
      if (i % step && !(i === n - 1 && (n - 1) % step >= step / 2)) return;
      const tx = svg("text", { x: X(i), y: H - 10, class: "ax", "text-anchor": "middle" });
      tx.textContent = fmtShort(p.a);
      g.append(tx);
    });

    const path = (pts, cls) => {
      let d = "", pen = false;
      pts.forEach((p, i) => {
        if (p.v == null || i >= n) { pen = false; return; }
        d += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.v).toFixed(1);
        pen = true;
      });
      if (d) g.append(svg("path", { d, class: cls }));
    };
    if (prev) path(prev, "line prev");
    path(cur, "line cur");
    const dots = n <= 31;
    cur.forEach((p, i) => { if (p.v != null && (dots || i === n - 1)) g.append(svg("circle", { cx: X(i), cy: Y(p.v), r: 4, class: "dot" })); });
    // قيمة آخر نقطة
    const lastI = cur.map((p) => p.v).lastIndexOf(cur.filter((p) => p.v != null).slice(-1)[0]?.v);
    if (lastI >= 0) {
      const tx = svg("text", { x: X(lastI), y: Y(cur[lastI].v) - 10, class: "val", "text-anchor": lastI > n / 2 ? "end" : "start" });
      tx.textContent = show(mt, cur[lastI].v);
      g.append(tx);
    }

    // طبقة التمرير: خط عمودي + تلميح
    const cross = svg("line", { y1: T, y2: H - B, class: "cross", visibility: "hidden" });
    g.append(cross);
    const tip = node("div", undefined, "tip");
    tip.hidden = true;
    const hit = svg("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
    const move = (ev) => {
      const r = g.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * W;
      const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((x - L) / (W - L - R)) * (n - 1))));
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
      const p = cur[i], q = prev ? prev[i] : null;
      tip.replaceChildren(node("strong", p.a === p.b ? fmt(p.a) : fmt(p.a) + " – " + fmt(p.b)), node("div", "الحالية: " + show(mt, p.v)));
      if (q) tip.append(node("div", "المقارنة: " + show(mt, q.v) + " (" + (q.a === q.b ? fmt(q.a) : fmt(q.a) + " – " + fmt(q.b)) + ")"));
      tip.hidden = false;
      const px = (X(i) / W) * r.width;
      tip.style.left = Math.min(Math.max(px - 90, 0), r.width - 180) + "px";
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
    g.append(hit);
    box.append(g, tip);

    // مفتاح الرسم
    const lg = $("d-legend");
    lg.replaceChildren();
    const key = (cls, t) => { const s = node("span", undefined, "lk"); s.append(node("i", undefined, cls), node("span", t)); return s; };
    lg.append(key("k-cur", "الفترة المختارة"));
    if (prev) lg.append(key("k-prev", cr[2]));
    if (mt.target != null) lg.append(key("k-tgt", "المستهدف"));
  }

  /* ترتيب الأقسام — الإحالة العكسية: أعلى 3 وأقل 3 حسب نسبة الصادرة إلى الواردة */
  function deptTotals(a, b) {
    const days = reverseDays(), m = {};
    let have = false;
    for (let d = a; d <= b; d = add(d, 1)) {
      if (!days[d]) continue;
      for (const x of deptDaysFor(d, days[d].rep)) {
        have = true;
        const o = (m[x.name] ??= { name: x.name, in: 0, out: 0, inKnown: false });
        if (x.in != null) { o.in += x.in; o.out += x.out || 0; o.inKnown = true; }
      }
    }
    return have ? Object.values(m) : null;
  }
  function drawRanking(cr) {
    const sec = $("d-rank-sec"), box = $("d-rank");
    box.replaceChildren();
    if (st.ind === "requests") return drawReasons(cr);
    if (st.ind !== "reverse") { sec.hidden = true; return; }
    sec.hidden = false;
    $("d-rank-title").textContent = "ترتيب الأقسام — مؤشر الإحالة العكسية";
    const cur = deptTotals(st.from, st.to);
    const prev = cr ? deptTotals(cr[0], cr[1]) : null;
    if (!cur) { box.append(node("p", "تفاصيل الأقسام غير متوفرة لهذه الفترة.", "empty")); return; }
    const MIN = 10;
    const rated = cur.filter((x) => x.inKnown && x.in >= MIN).map((x) => ({ ...x, r: (x.out / x.in) * 100 }));
    const pr = Object.fromEntries((prev || []).filter((x) => x.inKnown && x.in >= MIN).map((x) => [x.name, (x.out / x.in) * 100]));
    if (rated.length < 2) { box.append(node("p", "عدد الأقسام بواردة كافية (" + MIN + " فأكثر) قليل في هذه الفترة.", "empty")); return; }
    rated.sort((a, b) => b.r - a.r);
    const mt = IND.reverse.metrics[0];
    const table = (title, list) => {
      const wrap = node("div", undefined, "rank");
      wrap.append(node("h3", title));
      const t = node("table");
      const hr = node("tr");
      for (const h of ["القسم", "الصادرة", "الواردة", "المؤشر", cr ? "التغيّر" : ""]) if (h !== "") hr.append(node("th", h));
      t.append(hr);
      for (const x of list) {
        const tr = node("tr");
        const s = status(mt, x.r);
        const rc = node("td");
        rc.append(node("span", show(mt, x.r), "rv"), node("span", s ? " " + s[1].split(" ")[0] : "", "rs " + (s ? s[0] : "")));
        tr.append(node("td", x.name, "nm"), node("td", String(x.out)), node("td", String(x.in)), rc);
        if (cr) {
          const dl = pr[x.name] != null ? delta(mt, x.r, pr[x.name]) : null;
          tr.append(node("td", dl ? dl.arrow + " " + dl.txt : "—", dl ? "dl " + dl.tone : ""));
        }
        t.append(tr);
      }
      wrap.append(t);
      return wrap;
    };
    box.append(table("الأعلى", rated.slice(0, 3)), table("الأقل", rated.slice(-3).reverse()));
    box.append(node("p", "يشمل الأقسام اللي وصلها " + MIN + " إحالات واردة فأكثر في الفترة.", "page-note"));
  }

  /* أسباب عدم الحضور كما ذكرها المراجع في طلبات التجديد (بالأشهر اللي تشملها الفترة) */
  function reasonsFor(a, b) {
    const m = {};
    let have = false;
    for (const r of kindRows("requests")) {
      if (!(r.period_from <= b && r.period_to >= a)) continue;
      for (const [k, v] of Object.entries(r.summary.reasons || {})) { m[k] = (m[k] || 0) + v; have = true; }
    }
    return have ? m : null;
  }
  function drawReasons(cr) {
    const sec = $("d-rank-sec"), box = $("d-rank");
    sec.hidden = false;
    $("d-rank-title").textContent = "أسباب عدم الحضور (من طلبات التجديد)";
    box.replaceChildren();
    const cur = reasonsFor(st.from, st.to), prev = cr ? reasonsFor(cr[0], cr[1]) : null;
    if (!cur) { box.append(node("p", "لا توجد بيانات لهذه الفترة.", "empty")); return; }
    const tot = Object.values(cur).reduce((x, y) => x + y, 0), ptot = prev ? Object.values(prev).reduce((x, y) => x + y, 0) : 0;
    const wrap = node("div", undefined, "rank");
    const t = node("table"), hr = node("tr");
    for (const h of ["السبب", "العدد", "النسبة"].concat(cr ? ["التغيّر"] : [])) hr.append(node("th", h));
    t.append(hr);
    const mt = { pct: true, good: -1 };
    for (const [k, v] of Object.entries(cur).sort((x, y) => y[1] - x[1])) {
      const tr = node("tr"), sh = (v / tot) * 100;
      tr.append(node("td", k.replace(/[.:]$/, ""), "nm"), node("td", v.toLocaleString("en-US")), node("td", sh.toFixed(1) + "%"));
      if (cr) { const dl = prev && ptot && prev[k] != null ? delta(mt, sh, (prev[k] / ptot) * 100) : null; tr.append(node("td", dl ? dl.arrow + " " + dl.txt : "—", dl ? "dl " + dl.tone : "")); }
      t.append(tr);
    }
    wrap.append(t);
    box.append(wrap, node("p", "الأسباب محسوبة بالشهر كامل للأشهر اللي تشملها الفترة.", "page-note"));
  }

  /* ---------- التشغيل ---------- */
  function init() {
    for (const [k, v] of Object.entries(IND)) $("d-ind").add(new Option(v.label, k));
    $("d-ind").onchange = (e) => { st.ind = e.target.value; st.metric = IND[st.ind].metrics[0].k; render(); };
    $("d-metric").onchange = (e) => { st.metric = e.target.value; render(); };
    $("d-cmp").onchange = (e) => { st.cmp = e.target.value; render(); };
    for (const b of document.querySelectorAll("#d-presets button")) b.onclick = () => { setPreset(b.dataset.p); render(); };
    const custom = () => {
      if (!$("d-from").value || !$("d-to").value) return;
      st.from = $("d-from").value; st.to = $("d-to").value;
      if (st.to < st.from) [st.from, st.to] = [st.to, st.from];
      setPreset("custom");
      $("d-from").value = st.from; $("d-to").value = st.to;
      render();
    };
    $("d-from").onchange = custom;
    $("d-to").onchange = custom;
    setPreset("30");
  }
  init();
  window.addEventListener("kpi:data", (e) => { ROWS = e.detail || []; render(); });
})();
