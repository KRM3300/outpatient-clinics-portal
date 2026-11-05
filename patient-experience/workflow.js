/* Patient Experience workflow extension - demo only; no patient data. */
(function(){
'use strict';
const oldRender=render, oldDashboard=dashboard, oldRecords=records, oldForm=form, oldSettings=settings;
const key='opd_px_demo_v1';
const stamp=()=>new Date().toISOString();
const uid=()=>typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():'ev-'+Date.now()+'-'+Math.random().toString(36).slice(2);
const safe=x=>esc(x);
const statuses={open:'جديد',assigned:'مسند',in_progress:'قيد المعالجة',transferred:'محول',escalated:'مصعّد',closed:'مغلق',reopened:'أعيد فتحه'};
const types=['بلاغ','شكوى','ملاحظة'];
const demoActor=()=>db.users?.[0]?.name||'مستخدم تجريبي';
const defaultSla={عادي:72,مرتفع:24,عاجل:4};
function migrate(){
 if(!db||typeof db!=='object')db=seed();
 for(const k of ['incidents','ncr','compliance','surveys','users'])if(!Array.isArray(db[k]))db[k]=[];
 if(!db.settings||typeof db.settings!=='object')db.settings=seed().settings;
 for(const k of ['departments','roles','categories'])if(!Array.isArray(db.settings[k]))db.settings[k]=seed().settings[k];
 db.settings.slaHours=Object.assign({},defaultSla,db.settings.slaHours||{});
 for(const c of db.incidents){
  if(!c.caseUid)c.caseUid=uid();
  if(!Array.isArray(c.history))c.history=[{id:uid(),at:(c.date||today())+'T00:00:00',type:'imported',actor:'ترحيل بيانات',note:'سجل موجود قبل تطوير دورة البلاغ'}];
  c.kind=c.kind||'بلاغ';c.category=c.category||'أخرى';c.source=c.source||'أخرى';
  c.createdAt=c.createdAt||((c.date||today())+'T00:00:00');
  c.priority=c.priority||'عادي';
  if(!c.dueAt){const hours=Number(db.settings.slaHours[c.priority]||72);c.dueAt=new Date(new Date(c.createdAt).getTime()+hours*3600000).toISOString();}
 }
 db.schemaVersion=2;save();
}
function event(c,type,note,extra={}){
 c.history.push({id:uid(),at:stamp(),actor:demoActor(),type,note,...extra});save();
}
function label(s){return statuses[s]||status(s)}
function overdue(c){return c.status!=='closed'&&c.dueAt&&new Date(c.dueAt).getTime()<Date.now()}
function dateText(x){return x?new Date(x).toLocaleString('ar-SA'):'—'}
function actionButton(name,action){return '<button class="btn" data-case-action="'+action+'">'+name+'</button>'}
function caseList(){
 const list=db.incidents.filter(c=>(!filter||c.status===filter)&&(!query||[c.id,c.title,c.department,c.owner,c.category,c.kind].join(' ').toLowerCase().includes(query.toLowerCase())));
 $('#content').innerHTML='<section class="panel"><div class="toolbar"><h2>البلاغات والشكاوى</h2><button id="add" class="btn primary">+ إضافة بلاغ</button></div><div class="toolbar"><input id="search" style="max-width:320px" placeholder="بحث بالرقم أو العنوان أو القسم" value="'+safe(query)+'"><select id="filter" style="max-width:220px"><option value="">كل الحالات</option>'+Object.entries(statuses).map(([k,v])=>'<option value="'+k+'" '+(filter===k?'selected':'')+'>'+v+'</option>').join('')+'</select><button class="btn" id="csv">تصدير CSV</button></div><div class="tablewrap"><table><thead><tr><th>الرقم</th><th>البلاغ</th><th>القسم</th><th>المسؤول</th><th>الحالة</th><th>الاستحقاق</th><th>إجراءات</th></tr></thead><tbody>'+list.map(c=>'<tr><td>#'+safe(c.id)+'</td><td>'+safe(c.title)+'<div class="muted">'+safe(c.category)+'</div></td><td>'+safe(c.department)+'</td><td>'+safe(c.owner||'غير محدد')+'</td><td><span class="tag '+safe(c.status)+'">'+label(c.status)+'</span></td><td>'+dateText(c.dueAt)+(overdue(c)?' <span class="danger">متأخر</span>':'')+'</td><td><button class="btn" data-view="'+safe(c.caseUid)+'">التفاصيل</button></td></tr>').join('')+'</tbody></table></div>'+(list.length?'':'<p class="empty">لا توجد نتائج</p>')+'</section><div id="editor"></div>';
 $('#add').onclick=()=>caseForm();
 $('#search').oninput=e=>{query=e.target.value;caseList();$('#search').focus();$('#search').setSelectionRange(query.length,query.length)};
 $('#filter').onchange=e=>{filter=e.target.value;caseList()};
 document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>caseDetail(b.dataset.view));
 $('#csv').onclick=()=>downloadCsv(list);
}
function caseForm(id){
 const c=db.incidents.find(x=>x.caseUid===id)||{kind:'بلاغ',priority:'عادي',department:db.settings.departments[0],category:db.settings.categories[0],source:'حضوري'};
 $('#editor').innerHTML='<section class="panel"><h3>'+(id?'تعديل البلاغ':'إضافة بلاغ جديد')+'</h3><form id="caseform"><div class="fields"><div><label>العنوان</label><input name="title" required value="'+safe(c.title||'')+'"></div><div><label>نوع الحالة</label><select name="kind">'+opts(types,c.kind)+'</select></div><div><label>القسم</label><select name="department">'+opts(db.settings.departments,c.department)+'</select></div><div><label>التصنيف</label><select name="category">'+opts(db.settings.categories,c.category)+'</select></div><div><label>الأولوية</label><select name="priority">'+opts(['عادي','مرتفع','عاجل'],c.priority)+'</select></div><div><label>المصدر</label><select name="source">'+opts(['حضوري','اتصال هاتفي','بريد إلكتروني','قناة رسمية أخرى','أخرى'],c.source)+'</select></div><div><label>المسؤول</label><select name="owner"><option value="">غير محدد</option>'+opts(db.users.map(u=>u.name),c.owner)+'</select></div></div><label>الوصف</label><textarea name="description" required>'+safe(c.description||'')+'</textarea><p><button class="btn primary">حفظ</button> <button type="button" id="cancelcase" class="btn">إلغاء</button></p></form></section>';
 $('#cancelcase').onclick=()=>$('#editor').innerHTML='';
 $('#caseform').onsubmit=e=>{
  e.preventDefault();const o=Object.fromEntries(new FormData(e.target).entries());
  if(id){const prev={...c};Object.assign(c,o);event(c,'edited','تعديل بيانات البلاغ',{changes:Object.keys(o).filter(k=>prev[k]!==o[k])});}
  else{const createdAt=stamp(),hours=Number(db.settings.slaHours[o.priority]||72);const n={id:Math.max(1000,...db.incidents.map(x=>Number(x.id)||0))+1,caseUid:uid(),date:today(),createdAt,dueAt:new Date(Date.now()+hours*3600000).toISOString(),status:o.owner?'assigned':'open',resolution:'',history:[],...o};db.incidents.push(n);event(n,'created','تسجيل بلاغ جديد');}
  save();caseList();
 };
 $('#editor').scrollIntoView({behavior:'smooth'});
}
function caseDetail(id){
 const c=db.incidents.find(x=>x.caseUid===id);if(!c)return caseList();
 const history=c.history.slice().reverse().map(h=>'<div style="border-right:3px solid #cbdce5;padding:8px 12px;margin:9px 0"><b>'+safe(h.type)+'</b> · '+safe(h.actor)+'<div class="muted">'+dateText(h.at)+'</div><div>'+safe(h.note)+'</div></div>').join('');
 $('#content').innerHTML='<section class="panel"><div class="toolbar"><button class="btn" id="back">عودة للقائمة</button><span class="tag '+safe(c.status)+'">'+label(c.status)+'</span></div><h2>#'+safe(c.id)+' · '+safe(c.title)+'</h2><div class="fields"><p><b>النوع:</b> '+safe(c.kind)+'</p><p><b>التصنيف:</b> '+safe(c.category)+'</p><p><b>القسم:</b> '+safe(c.department)+'</p><p><b>المسؤول:</b> '+safe(c.owner||'غير محدد')+'</p><p><b>الأولوية:</b> '+safe(c.priority)+'</p><p><b>الاستحقاق:</b> '+dateText(c.dueAt)+'</p></div><p>'+safe(c.description)+'</p><div class="actions">'+actionButton('تعديل','edit')+actionButton('إسناد','assign')+actionButton('بدء المعالجة','progress')+actionButton('إضافة إجراء','note')+actionButton('تحويل','transfer')+actionButton('تصعيد','escalate')+actionButton('إغلاق','close')+actionButton('إعادة فتح','reopen')+'</div></section><section class="panel"><h3>سجل الإجراءات</h3>'+(history||'<p class="empty">لا توجد أحداث</p>')+'</section><div id="editor"></div>';
 $('#back').onclick=caseList;
 document.querySelectorAll('[data-case-action]').forEach(b=>b.onclick=()=>caseAction(c,b.dataset.caseAction));
}
function caseAction(c,a){
 if(a==='edit'){caseList();return caseForm(c.caseUid)}
 if(a==='close'&&c.status==='closed')return alert('البلاغ مغلق بالفعل');
 if(a==='reopen'&&c.status!=='closed')return alert('إعادة الفتح متاحة للبلاغات المغلقة فقط');
 if(c.status==='closed'&&a!=='reopen')return alert('أعد فتح البلاغ قبل اتخاذ إجراء جديد');
 if(a==='progress'){c.status='in_progress';event(c,'processing','بدء المعالجة');return caseDetail(c.caseUid)}
 const labels={assign:'إسناد',note:'إضافة إجراء',transfer:'تحويل',escalate:'تصعيد',close:'إغلاق',reopen:'إعادة فتح'};
 const needsOwner=['assign','transfer','escalate'].includes(a);
 $('#editor').innerHTML='<section class="panel"><h3>'+labels[a]+'</h3><form id="actionform">'+(needsOwner?'<label>القسم المستلم</label><select name="department">'+opts(db.settings.departments,c.department)+'</select><label>المسؤول المستلم</label><select name="owner"><option value="">غير محدد</option>'+opts(db.users.map(u=>u.name),c.owner)+'</select>':'')+'<label>'+(a==='close'?'نتيجة المعالجة وسبب الإغلاق':'سبب / تفاصيل الإجراء')+'</label><textarea name="note" required minlength="5"></textarea><p><button class="btn primary">تأكيد</button> <button type="button" class="btn" id="cancelaction">إلغاء</button></p></form></section>';
 $('#cancelaction').onclick=()=>caseDetail(c.caseUid);
 $('#actionform').onsubmit=e=>{
  e.preventDefault();const v=Object.fromEntries(new FormData(e.target).entries());
  if(needsOwner){if(!v.owner)return alert('حدد المسؤول المستلم');c.department=v.department;c.owner=v.owner;}
  if(a==='close'){if(!c.owner)return alert('يجب إسناد البلاغ لمسؤول قبل إغلاقه');c.status='closed';c.resolution=v.note;c.closedAt=stamp();c.closedBy=c.owner;}
  if(a==='reopen'){c.status='reopened';c.reopenedAt=stamp();}
  if(a==='transfer')c.status='transferred';
  if(a==='escalate')c.status='escalated';
  if(a==='assign')c.status='assigned';
  event(c,a,v.note,{department:c.department,owner:c.owner});caseDetail(c.caseUid);
 };
 $('#editor').scrollIntoView({behavior:'smooth'});
}
function downloadCsv(list){
 const cols=['id','date','kind','title','department','owner','category','priority','status','dueAt','closedAt'];
 const quote=x=>'"'+String(x??'').replace(/"/g,'""').replace(/^[=+\-@]/,"'$&")+'"';
 const data='\ufeff'+[cols.join(','),...list.map(x=>cols.map(k=>quote(x[k])).join(','))].join('\r\n');
 const u=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=u;a.download='patient-experience-cases.csv';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
}
function newDashboard(){
 oldDashboard();
 const a=db.incidents,late=a.filter(overdue).length,reopened=a.filter(c=>c.history.some(h=>h.type==='reopen')).length;
 const closed=a.filter(c=>c.status==='closed'&&c.closedAt);
 const avg=closed.length?Math.round(closed.reduce((sum,c)=>sum+(new Date(c.closedAt)-new Date(c.createdAt))/3600000,0)/closed.length):0;
 const ontime=closed.length?Math.round(closed.filter(c=>new Date(c.closedAt)<=new Date(c.dueAt)).length/closed.length*100):0;
 $('#content').insertAdjacentHTML('afterbegin','<div class="stats"><div class="stat">بلاغات متأخرة<b>'+late+'</b></div><div class="stat">إعادة فتح<b>'+reopened+'</b></div><div class="stat">متوسط المعالجة (ساعة)<b>'+avg+'</b></div><div class="stat">الإغلاق ضمن المدة<b>'+ontime+'%</b></div></div>');
}
function newSettings(){
 oldSettings();
 $('#content .panel').insertAdjacentHTML('beforeend','<hr><h3>مدد المعالجة التجريبية (ساعات)</h3><form id="slaform"><div class="fields">'+Object.entries(db.settings.slaHours).map(([k,v])=>'<div><label>'+safe(k)+'</label><input type="number" min="1" max="8760" required name="'+safe(k)+'" value="'+safe(v)+'"></div>').join('')+'</div><p><button class="btn primary">حفظ مدد المعالجة</button></p></form><p class="muted">تطبق المدد الجديدة على البلاغات الجديدة فقط، دون تغيير استحقاقات البلاغات السابقة.</p>');
 $('#slaform').onsubmit=e=>{e.preventDefault();for(const [k,v] of new FormData(e.target))db.settings.slaHours[k]=Number(v);save();alert('تم الحفظ')};
 // Repair newline splitting in the original settings form.
 $('#sf').onsubmit=e=>{e.preventDefault();const fd=new FormData(e.target);for(const k of ['departments','roles','categories'])db.settings[k]=String(fd.get(k)).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);save();alert('تم الحفظ');newSettings()};
 // Validate imported backup before replacing current state.
 $('#importfile').onchange=async e=>{try{const v=JSON.parse(await e.target.files[0].text());if(!v||!Array.isArray(v.incidents)||!Array.isArray(v.ncr)||!Array.isArray(v.compliance)||!Array.isArray(v.surveys)||!Array.isArray(v.users)||!v.settings||!Array.isArray(v.settings.departments))throw Error('invalid schema');if(!confirm('استبدال البيانات التجريبية الحالية بالنسخة المستوردة؟'))return;db=v;migrate();render()}catch(err){alert('ملف JSON غير صالح أو غير متوافق')}};
}
render=function(){oldRender();if(tab==='incidents')caseList();else if(tab==='dashboard')newDashboard();else if(tab==='settings')newSettings()};
migrate();render();
})();