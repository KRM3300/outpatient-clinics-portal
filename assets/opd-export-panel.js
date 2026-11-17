/* Adds aggregate-only PDF and Excel exports to existing OPD dashboards.
   Uses an authorization-checked server RPC; never queries patient-level rows. */
(function(){
"use strict";
const script=document.currentScript;
const kind=script?.dataset?.reportKind;
const config={
 kpi:"الأداء والمؤشرات",
 productivity:"إنتاجية الموظفين",
 patient_experience:"تجربة المريض",
 noncompliance:"تقرير عدم الالتزام"
};
if(!kind||!config[kind])return;
const host=document.querySelector("main")||document.body;
const box=document.createElement("section");
box.className="opd-report-export-box";
box.setAttribute("aria-label","تحميل تقارير مجمعة");
box.innerHTML=`<div class="opd-exp-head"><strong>تحميل مؤشرات ${config[kind]}</strong><span>أرقام مجمعة فقط — دون بيانات المرضى</span></div>
<div class="opd-exp-actions">
<label>من تاريخ <input type="date" data-field="from"></label>
<label>إلى تاريخ <input type="date" data-field="to"></label>
<button type="button" data-action="pdf">تحميل PDF</button>
<button type="button" data-action="excel">تحميل Excel</button>
</div><p class="opd-exp-msg" role="status" aria-live="polite"></p>`;
const style=document.createElement("style");
style.textContent=`.opd-report-export-box{background:var(--card,#fff);color:var(--ink,#14333e);border:1px solid var(--line,#d9e4e8);border-radius:14px;padding:16px;margin:14px auto;max-width:1200px;direction:rtl;font-family:"IBM Plex Sans Arabic",Tahoma,Arial,sans-serif}
.opd-exp-head{display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap}
.opd-exp-head strong{font-size:1.08rem}.opd-exp-head span{color:#56717a;font-size:.82rem}
.opd-exp-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-top:10px}.opd-exp-actions label{font-size:.83rem;display:grid;gap:4px}
.opd-exp-actions input{font:inherit;border:1px solid #a9c5ca;border-radius:7px;padding:7px}
.opd-exp-actions button{font:inherit;background:#0f6572;color:white;border:0;border-radius:8px;padding:10px 15px;cursor:pointer}
.opd-exp-actions button:disabled{opacity:.55;cursor:wait}
.opd-exp-msg{font-size:.85rem;color:#47636c;margin:8px 0 0;min-height:1em}`;
document.head.append(style);
host.insertBefore(box,host.firstChild);
const from=box.querySelector('[data-field="from"]'),to=box.querySelector('[data-field="to"]');
const buttons=box.querySelectorAll("button"),msg=box.querySelector(".opd-exp-msg");
const fmtParts=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Riyadh",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
const read=p=>fmtParts.find(x=>x.type===p)?.value;
const today=read("year")+"-"+read("month")+"-"+read("day");
from.value=today.slice(0,8)+"01";to.value=today;
let last=null,lastKey="";
async function getReport(){
 if(!from.value||!to.value||from.value>to.value)throw Error("حدد فترة زمنية صحيحة.");
 const key=from.value+"|"+to.value;
 if(last&&lastKey===key)return last;
 if(!window.supabase)throw Error("تعذر تحميل مكتبة الدخول.");
 const api=window.supabase.createClient("https://omugonzzrulsdpnycact.supabase.co","sb_publishable_f3IjPvIbMruO9jGb4SmT7Q_NOqgEbXs");
 const signed=await api.auth.getUser();
 if(!signed.data?.user)throw Error("سجّل دخولك أولًا من المنصة لتتمكن من تحميل التقرير.");
 const r=await api.rpc("opd_export_dashboard",{p_section:kind,p_from:from.value,p_to:to.value});
 if(r.error)throw Error(/authorized|allowed|permission/i.test(r.error.message)?"لا تملك صلاحية عرض هذا التقرير.":r.error.message);
 const s=r.data?.sections;
 if(!Array.isArray(s))throw Error("تعذر قراءة الإحصائية المجمعة.");
 last=s;lastKey=key;return s;
}
async function download(format){
 buttons.forEach(b=>b.disabled=true);msg.textContent="يجري إعداد التقرير المجمع...";
 try{
  const sections=await getReport();
  if(!window.OPDExport)throw Error("تعذر تحميل أداة التصدير.");
  const period=from.value+" — "+to.value;
  if(format==="pdf")window.OPDExport.downloadPDF(config[kind],sections,period);
  else window.OPDExport.downloadExcel(config[kind],sections,period);
  msg.textContent="تم تجهيز تقرير "+(format==="pdf"?"PDF":"Excel")+" للأرقام المجمعة.";
 }catch(e){msg.textContent=e.message||"تعذر التحميل.";}
 finally{buttons.forEach(b=>b.disabled=false);}
}
box.querySelector('[data-action="pdf"]').onclick=()=>download("pdf");
box.querySelector('[data-action="excel"]').onclick=()=>download("excel");
from.onchange=to.onchange=()=>{last=null;lastKey="";};
})();