/* Unified booking v1 preview. Runs only after its staged SQL migration has been applied. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const api = window.supabase.createClient(
    "https://omugonzzrulsdpnycact.supabase.co",
    "sb_publishable_f3IjPvIbMruO9jGb4SmT7Q_NOqgEbXs"
  );
  const names = {
    followup:"متابعة العيادات", affiliate:"المستشفيات التابعة",
    low_back:"عيادة أسفل الظهر", breast_screening:"الكشف المبكر للثدي",
    emergency:"الطوارئ", phc_triage:"فرز المراكز الصحية"
  };
  const descriptions={
    followup:"حجز موعد متابعة من داخل العيادات، في حال تعثّر الحجز من العيادة.",
    affiliate:"حجز متابعة لمرضى المستشفيات التابعة من قِبل أطبائنا الزائرين.",
    low_back:"طلبات عيادة أسفل الظهر بالمركز الصحي إلى جراحة المخ والأعصاب.",
    breast_screening:"طلبات الكشف المبكر لسرطان الثدي إلى الجراحة العامة.",
    emergency:"مسار الطوارئ المؤقت وفق الصلاحيات الممنوحة.",
    phc_triage:"المسار البديل للمراكز الصحية عند تعطل نظام موعد، ويُفعّله مدير العيادات فقط."
  };
  const permission = {
    followup:"appt_fu_request", affiliate:"appt_affiliate_request",
    low_back:"appt_low_back_request", breast_screening:"appt_breast_request",
    emergency:"appt_er_request", phc_triage:"appt_phc_triage_request"
  };
  const affiliates=["مستشفى النبهانية","مستشفى عقلة الصقور","مستشفى ضرية","مركز ضلع رشيد","مركز دخنة"];
  const phcs=[
    "مركز صحي الحوطة","مركز صحي الملك خالد","مركز صحي الروضة","مركز صحي الجريف",
    "مركز صحي الملك عبد العزيز","مركز صحي الغربي","مركز صحي دخنة","مركز صحي الجندل",
    "مركز صحي قصر بن عقيل","مركز صحي الخشيبي","مركز صحي الصليبي","مركز صحي الشبيكية",
    "مركز صحي الجرذاوية","مركز صحي ضليع رشيد","مركز صحي الغضياء والسلمات",
    "مركز صحي رفايع اللهيب","مركز صحي الهمجه","مركز صحي الدحلة",
    "مركز صحي المطار","مركز صحي الركنة","مركز صحي القاعية"
  ];
  const OTHER="__other__";
  const OTHER_LABEL="غير موجود في القائمة، أكتبه";
  const MANUAL_LABEL={facility:"الجهة",clinic:"العيادة",doctor:"الطبيب"};
  const doctorRoutes=["affiliate","low_back"];
  const strictPatientRoutes=["affiliate","phc_triage"];
  // The two 16-clinic lists follow the existing Forms response field values;
  // do not introduce a 21st PHC until its source name is verified.
  const affiliateClinics=[
    ["Ophthalmology","العيون"],["Surgery","الجراحة العامة"],
    ["Medical","الباطنة"],["Dermatology","الجلدية"],
    ["ENT","الأنف والأذن والحنجرة"],["Optometry","البصريات"],
    ["Gastroenterology","الجهاز الهضمي"],["Urology","المسالك البولية"],
    ["Endocrinology","غدد كبار"],["Orthopedic","جراحة العظام"],
    ["Pediatric Surgery","جراحة الأطفال"],["Pediatric","الأطفال"],
    ["Plastic Surgery","جراحة التجميل"],["Rheumatology","الروماتزم"],
    ["Neurosurgery","جراحة المخ والأعصاب"],["Psychiatric","الطب النفسي"]
  ];
  const phcClinics=[
    ["Orthopedic Screening","فرز العظام"],["Medical Screening","فرز الباطنة"],
    ["Dermatology Screening","فرز الجلدية"],["Ophthalmology Screening","فرز العيون"],
    ["ENT Screening","فرز الأنف والأذن والحنجرة"],
    ["OB/Gyn Screening","فرز النساء والولادة"],["Surgery Screening","فرز الجراحة"],
    ["Pediatric Screening","فرز الأطفال"],["Diabetic Screening","فرز السكري"],
    ["Urology Screening","فرز المسالك البولية"],["Psychiatric Screening","فرز الطب النفسي"],
    ["Gastroenterology","الجهاز الهضمي"],["Endocrinology Screening","فرز الغدد الصماء"],
    ["Pediatric Endocrinology Screening","فرز غدد الأطفال"],
    ["Pediatric Surgery","جراحة الأطفال"],["Pediatric Diabetes Screening","فرز سكري الأطفال"]
  ];
  const allClinics=(window.OPD_UNIFIED_CLINICS||[]).map(s=>[s,s]);
  const sourceFacility = {followup:["مستشفى الرس العام"],affiliate:[...affiliates,OTHER],
    low_back:["المركز الصحي"],breast_screening:["قسم الأشعة"],
    emergency:["الطوارئ"],phc_triage:[...phcs,OTHER]};
  const statuses={pending:"بانتظار الحجز",processing:"قيد المعالجة",
    booked:"تم الحجز",unable:"تعذر الحجز",rejected:"مرفوض",cancelled:"ملغي"};
  const rejectedReasons=["عدم توفر موعد","بيانات ناقصة","عدم انطباق ضوابط المسار",
    "طلب مكرر","توجيه لجهة أخرى","سبب آخر"];
  let user=null,member=null,perms=new Set(),settings={emergency:false,phc_triage:false};
  // قائمة الأطباء المحلية تظهر فورًا، ويُحدّث فقط تخصص العيادة المختارة من Supabase عند الحاجة.
  // هذا يمنع تحميل جميع الأطباء عند كل دخول للصفحة.
  let vidaDoctorsMap=window.OPD_VIDA_DOCTORS||{};
  const vidaDoctorsLoaded=new Set();
  async function refreshVidaDoctors(clinic){
    clinic=String(clinic||"").trim();
    if(!clinic||clinic===OTHER||vidaDoctorsLoaded.has(clinic))return;
    vidaDoctorsLoaded.add(clinic);
    try{
      const {data,error}=await api.from("opd_vida_doctors")
        .select("full_name").eq("clinic",clinic).order("full_name").limit(200);
      if(error)throw error;
      if(Array.isArray(data)&&data.length){
        vidaDoctorsMap[clinic]=[...new Set(data.map(x=>String(x.full_name||"").trim()).filter(Boolean))];
      }
    }catch(_error){
      // عند تعذر الشبكة تبقى القائمة المحلية المتاحة فورًا، ويمكن إعادة المحاولة لاحقًا.
      vidaDoctorsLoaded.delete(clinic);
    }
  }

  let queueData=[],queueKind="all",queueOffset=0,queueHasMore=true,lastReport=null;
  let queueMode="mine";
  let section="entry",queueBusy=false;
  const can = x => member?.role==="admin" || perms.has(x);
  const handler = () => can("appt_booking_handle") || can("appt_er_handle") || can("appt_fu_handle");
  const admin = () => can("appt_booking_admin");
  const statusClosed = s => ["booked","unable","rejected","cancelled"].includes(s);
  const el=(t,txt,cls)=>{const n=document.createElement(t);if(txt!==undefined)n.textContent=txt;if(cls)n.className=cls;return n;};
  const clear=n=>n.replaceChildren();
  function feedback(id,msg,ok){$(id).textContent=msg||"";$(id).className=ok?"success":"error";}
  function setupSelect(id,items,placeholder) {
    const node=$(id);clear(node);node.add(new Option(placeholder||"اختر",""));
    for(const [value,label] of items)node.add(new Option(label,value));
  }
  const isPhysician=()=>["doctor","phc_doctor"].includes(member?.role)||["doctor","phc_doctor"].includes(member?.job_title);
  const currentKind=()=>$("kind").value;
  function available(k){return settings[k] !== false;}
  function allowedKinds(){return Object.keys(names).filter(k=>can(permission[k])&&available(k));}
  function drawForm(){
    const allowed=allowedKinds();
    const prev=currentKind();
    setupSelect("kind",allowed.map(k=>[k,names[k]]),"اختر نوع الخدمة");
    if(allowed.includes(prev))$("kind").value=prev;
    updateKind();
  }
  function updateKind(){
    const k=currentKind(),f=sourceFacility[k]||[];
    $("routeDescription").textContent=descriptions[k]||"اختر مسار الخدمة.";
    setupSelect("facility",f.map(v=>[v,v===OTHER?OTHER_LABEL:v]),"اختر الجهة");
    $("facilityOtherWrap").classList.add("hidden");
    $("facilityOther").required=false;
    let clinics=(k==="affiliate" ? affiliateClinics :
      k==="phc_triage" ? phcClinics :
      k==="low_back" ? [["Neurosurgery","جراحة المخ والأعصاب"]] :
      k==="breast_screening" ? [["Surgery","الجراحة العامة"]] : allClinics);
    if(["affiliate","phc_triage"].includes(k))clinics=[...clinics,[OTHER,OTHER_LABEL]];
    setupSelect("clinic",clinics,"اختر العيادة");
    if(f.length===1)$("facility").value=f[0];
    if(k==="low_back")$("clinic").value="Neurosurgery";
    if(k==="breast_screening")$("clinic").value="Surgery";
    $("clinicOtherWrap").classList.add("hidden");$("clinicOther").required=false;
    $("doctorWrap").classList.toggle("hidden",!doctorRoutes.includes(k));
    drawDoctors();
    const idInput=document.querySelector('[name="patient_identifier"]');
    if(strictPatientRoutes.includes(k)){idInput.pattern="[12][0-9]{9}";idInput.maxLength=10;idInput.title="10 أرقام تبدأ بـ1 أو 2";}
    else{idInput.removeAttribute("pattern");idInput.maxLength=30;idInput.removeAttribute("title");}
    document.querySelector('[name="patient_dob"]').max=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Riyadh"});
    $("motherWrap").classList.toggle("hidden",k!=="affiliate");
    const input=document.querySelector('[name="mother_name"]');
    input.required=k==="affiliate";
    // For nurses and scheduling staff, record the treating doctor's name without
    // claiming the signed-in staff member was the physician.
    const nonDoctor=member && !isPhysician();
    $("requestDoctorWrap").classList.toggle("hidden",!nonDoctor);
    document.querySelector('[name="referring_doctor"]').required=!!nonDoctor;
    $("expectedDateWrap").classList.toggle("hidden",!["followup","emergency"].includes(k));
    $("periodWrap").classList.toggle("hidden",!["followup","emergency"].includes(k));
  }
  function drawDoctors(skipRefresh=false){
    const k=currentKind(),clinic=$("clinic").value,need=doctorRoutes.includes(k);
    const list=clinic&&clinic!==OTHER?(vidaDoctorsMap[clinic]||[]):[];
    setupSelect("doctorSel",[...list.map(n=>[n,n]),...(clinic?[[OTHER,OTHER_LABEL]]:[])],clinic?"اختر الطبيب":"اختر العيادة أولًا");
    if(need&&clinic&&!list.length)$("doctorSel").value=OTHER;
    $("doctorSel").required=need;
    toggleDoctorOther();
    if(!skipRefresh&&need&&clinic&&clinic!==OTHER){
      refreshVidaDoctors(clinic).then(()=>{
        if(currentKind()===k&&$("clinic").value===clinic)drawDoctors(true);
      });
    }
  }
  function toggleDoctorOther(){
    const on=doctorRoutes.includes(currentKind())&&$("doctorSel").value===OTHER;
    $("doctorOtherWrap").classList.toggle("hidden",!on);$("doctorOther").required=on;
  }
  function panel(id){
    section=id;
    for(const x of ["entry","queue","stats","settings"])$(x).classList.toggle("hidden",x!==id);
    $("navNew").classList.toggle("alt",id!=="entry");
    $("navMine").classList.toggle("alt",!(id==="queue"&&queueMode==="mine"));
    $("navQueue").classList.toggle("alt",!(id==="queue"&&queueMode==="manage"));
    $("navStats").classList.toggle("alt",id!=="stats");
    $("navSettings").classList.toggle("alt",id!=="settings");
  }
  function showState(name){
    for(const id of ["auth","onboard","waiting","app"])$(id).classList.toggle("hidden",id!==name);
  }
  async function load(){
    const auth=await api.auth.getSession();
    if(auth.error){
      feedback("authMessage","تعذر قراءة جلسة الدخول. تحقق من الاتصال ثم أعد المحاولة.");
      return;
    }
    user=auth.data?.session?.user||null;
    if(!user){member=null;showState("auth");return;}
    const [m,p,c]=await Promise.all([
      api.from("opd_appt_members").select("user_id,full_name,employee_no,job_title,department,role,status").eq("user_id",user.id).maybeSingle(),
      api.from("opd_user_perms").select("perm").eq("user_id",user.id),
      api.from("opd_booking_route_settings").select("kind,enabled")
    ]);
    if(m.error||p.error){
      feedback("authMessage","تعذر تحميل الحساب مؤقتًا. جلسة الدخول ما زالت محفوظة؛ حدّث الصفحة أو حاول مرة أخرى.");
      return;
    }
    member=m.data;
    if(!member){showState("onboard");return;}
    if(member.status!=="approved"){
      showState("waiting");
      feedback("waitMessage",member.full_name+" — الحالة: "+member.status);
      return;
    }
    perms=new Set((p.data||[]).map(v=>v.perm));
    if(!c.error)for(const s of c.data||[])settings[s.kind]=s.enabled;
    $("identity").textContent=member.full_name+" — "+(member.department||"");
    showState("app");
    $("navSettings").classList.toggle("hidden",!admin());
    $("navStats").classList.toggle("hidden",!handler());
    $("navMine").classList.remove("hidden");
    $("navQueue").classList.toggle("hidden",!handler());
    $("navNew").classList.toggle("hidden",!allowedKinds().length);
    drawForm();
    panel(allowedKinds().length?"entry":"queue");
    if(!allowedKinds().length){
      queueMode="mine";
      await loadQueue(true);
    }
  }
  $("sendOtp").onclick=async()=>{
    const email=$("email").value.trim();
    if(!email)return feedback("authMessage","أدخل البريد الإلكتروني.");
    const r=await api.auth.signInWithOtp({email,options:{shouldCreateUser:true,emailRedirectTo:location.origin+location.pathname}});
    feedback("authMessage",r.error?r.error.message:"أُرسل رمز التحقق إلى بريدك الإلكتروني.",!r.error);
  };
  $("verifyOtp").onclick=async()=>{
    const r=await api.auth.verifyOtp({email:$("email").value.trim(),token:$("otp").value.trim(),type:"email"});
    if(r.error)return feedback("authMessage",r.error.message);
    await load();
  };
  async function logout(){
    await api.auth.signOut({scope:"local"});user=null;member=null;perms=new Set();await load();
  }
  for(const id of ["logout","joinLogout","waitLogout"])$(id).onclick=logout;
  $("checkApproval").onclick=load;
  $("joinForm").onsubmit=async e=>{
    e.preventDefault();
    const full=$("joinName").value.trim(),emp=$("joinNumber").value.trim(),
      job=$("joinJob").value,dept=$("joinDepartment").value.trim(),phone=$("joinPhone").value.trim();
    if(full.split(/\s+/).length<4)return feedback("joinMessage","أدخل اسمك الرباعي.");
    if(!/^\d{4,12}$/.test(emp))return feedback("joinMessage","أدخل رقمًا وظيفيًا صحيحًا.");
    if(!job||dept.length<2)return feedback("joinMessage","اختر الفئة وحدد القسم أو المنشأة.");
    if(phone&&!/^\+?\d{9,15}$/.test(phone))return feedback("joinMessage","أدخل رقم جوال صحيحًا.");
    $("joinSave").disabled=true;
    const r=await api.from("opd_appt_members").insert({
      user_id:user.id,full_name:full,employee_no:emp,job_title:job,
      department:dept,phone:phone||null,role:"pending",status:"pending"
    });
    $("joinSave").disabled=false;
    if(r.error)return feedback("joinMessage",r.error.message);
    await load();
  };
  $("kind").onchange=updateKind;
  $("clinic").onchange=()=>{
    const other=$("clinic").value===OTHER;
    $("clinicOtherWrap").classList.toggle("hidden",!other);$("clinicOther").required=other;
    drawDoctors();
  };
  $("doctorSel").onchange=toggleDoctorOther;
  $("facility").onchange=()=>{
    const other=$("facility").value===OTHER;
    $("facilityOtherWrap").classList.toggle("hidden",!other);
    $("facilityOther").required=other;
  };
  $("bookingForm").onsubmit=async e=>{
    e.preventDefault();feedback("entryMessage","");
    const k=currentKind();
    if(!user||!allowedKinds().includes(k))return feedback("entryMessage","الخدمة غير مفعّلة لحسابك.");
    const formEl=e.currentTarget;
    const f=new FormData(formEl);
    const pn=String(f.get("patient_name")||"").trim();
    if(pn.split(/\s+/).length<4)return feedback("entryMessage","يجب كتابة اسم المراجع الرباعي.");
    if(!/^\+?[0-9]{9,15}$/.test(String(f.get("patient_mobile")||"").trim()))
      return feedback("entryMessage","أدخل رقم جوال صحيحًا.");
    const d=["followup","emergency"].includes(k)?f.get("clinic_date"):null;
    const today=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Riyadh"});
    const pid=String(f.get("patient_identifier")||"").trim(),dob=String(f.get("patient_dob")||"");
    if(strictPatientRoutes.includes(k)){
      if(!/^[12]\d{9}$/.test(pid))return feedback("entryMessage","رقم الهوية أو الإقامة يجب أن يكون 10 أرقام يبدأ بـ1 أو 2. لا يُقبل الطلب بدون هوية.");
      if(!dob)return feedback("entryMessage","تاريخ الميلاد إلزامي.");
    }
    if(dob&&dob>today)return feedback("entryMessage","تاريخ الميلاد لا يمكن أن يكون في المستقبل.");
    const manual=[];
    let facilityValue=String($("facility").value||"");
    if(facilityValue===OTHER){facilityValue=$("facilityOther").value.trim();manual.push("facility");}
    let clinicValue=$("clinic").value;
    if(clinicValue===OTHER){clinicValue=$("clinicOther").value.trim();manual.push("clinic");}
    let doctorValue=null;
    if(doctorRoutes.includes(k)){
      doctorValue=$("doctorSel").value;
      if(doctorValue===OTHER){doctorValue=$("doctorOther").value.trim();manual.push("doctor");}
      if(!doctorValue)return feedback("entryMessage","اختر اسم الطبيب أو اكتبه كاملاً.");
    }
    const form= {
      kind:k, requested_by:user.id, requester_name:member.full_name,
      source_facility:facilityValue,
      clinic_name:clinicValue,
      patient_name:pn,patient_identifier:pid,
      patient_dob:f.get("patient_dob")||null,patient_mobile:String(f.get("patient_mobile")||"").trim(),
      mother_name:k==="affiliate"?String(f.get("mother_name")||"").trim():null,
      diagnosis_reason:String(f.get("diagnosis_reason")||"").trim(),
      request_note:String(f.get("request_note")||"").trim()||null,
      referring_doctor:isPhysician()?
        member.full_name:String(f.get("referring_doctor")||"").trim(),
      doctor_name:doctorValue,clinic_date:d||null,
      manual_fields:manual.length?manual:null,
      period:["followup","emergency"].includes(k)?f.get("period")||null:null,
      status:"pending"
    };
    if(!form.source_facility||!form.clinic_name||!form.diagnosis_reason||
       (k==="affiliate"&&!form.mother_name)||!form.referring_doctor)
      return feedback("entryMessage","أكمل الحقول المطلوبة للمسار.");
    if(d && d < today)
      return feedback("entryMessage","لا يمكن طلب تاريخ سابق.");
    $("submit").disabled=true;
    const r=await api.from("opd_appt_requests").insert(form);
    $("submit").disabled=false;
    if(r.error)return feedback("entryMessage",r.error.message);
    formEl.reset();updateKind();
    feedback("entryMessage","تم رفع الطلب، ولم يتم حجز موعد في VIDA بعد."+(manual.length?" وصل تنبيه للمدير بالاسم المكتوب يدويًا.":""),true);
  };
  const showTab=(k)=>{
    const b=el("button",k==="all"?"الكل":names[k],"tab"+(queueKind===k?" active":""));
    b.onclick=()=>{queueKind=k;loadQueue(true);};
    return b;
  };
  function buildTabs(){
    const root=$("routeTabs");clear(root);root.append(showTab("all"));
    const visible=queueMode==="manage"
      ?(can("appt_booking_handle")?Object.keys(names):
        [...new Set([
          ...(can("appt_er_handle")?["emergency"]:[]),
          ...(can("appt_fu_handle")?["followup"]:[])
        ])])
      :allowedKinds();
    for(const k of visible)root.append(showTab(k));
  }
  function hoursUntilNow(date){
    return (Date.now()-new Date(date).getTime())/3600000;
  }
  const DONE_NOTES=["تم الحجز وإبلاغ المراجع","تم الحجز في أقرب موعد متاح","تم الحجز مع الطبيب المطلوب","تم الحجز مع طبيب آخر بنفس التخصص"];
  const NOT_DONE_NOTES=["لا يوجد موعد متاح حالياً","بانتظار فتح جدول الطبيب","تعذّر التواصل مع المراجع","بيانات المراجع ناقصة أو غير صحيحة","لا تنطبق عليه ضوابط المسار","طلب مكرر","يحتاج تحويل لجهة أخرى"];
  const CLOSING_NOTES=["طلب مكرر","لا تنطبق عليه ضوابط المسار"];
  const NOTE_OTHER="أخرى";
  async function saveStatus(id,done,note,btn,msg){
    btn.disabled=true;msg.className="save-msg hint";msg.textContent="جارٍ الحفظ…";
    const r=await api.rpc("opd_booking_set",{p_id:id,p_done:done,p_note:note});
    btn.disabled=false;
    if(r.error){msg.className="save-msg error";msg.textContent="لم يُحفظ: "+r.error.message;return;}
    feedback("queueMessage",r.data==="processing"?"حُفظت الملاحظة، والطلب ما زال مفتوحاً.":"حُفظت الحالة وأُقفل الطلب.",true);
    await loadQueue(true);
  }
  // معالجة الطلب: تم / لم يتم + ملاحظة من قائمة (مع «أخرى») — مثل الخدمات الإلكترونية
  function actionBox(r,container){
    const wrap=el("div",undefined,"actions");
    const st=el("select");st.style.maxWidth="140px";
    st.add(new Option("الحالة",""));st.add(new Option("تم","done"));st.add(new Option("لم يتم","not"));
    const note=el("select");note.style.maxWidth="320px";note.disabled=true;
    const other=el("input");other.placeholder="اكتب الملاحظة";other.maxLength=300;other.classList.add("hidden");other.style.maxWidth="320px";
    const save=el("button","حفظ");
    const fill=()=>{
      while(note.options.length)note.remove(0);
      const list=st.value==="done"?DONE_NOTES:st.value==="not"?NOT_DONE_NOTES:[];
      note.add(new Option(list.length?"اختر الملاحظة":"اختر الحالة أولاً",""));
      for(const n of list)note.add(new Option(n+(CLOSING_NOTES.includes(n)?" (يُقفل الطلب)":""),n));
      if(list.length)note.add(new Option(NOTE_OTHER,NOTE_OTHER));
      note.disabled=!list.length;other.classList.add("hidden");other.value="";
    };
    fill();
    st.onchange=fill;
    note.onchange=()=>other.classList.toggle("hidden",note.value!==NOTE_OTHER);
    // رسالة الحفظ داخل بطاقة الطلب نفسها حتى تظهر للموظف مباشرة
    const msg=el("p","","save-msg");
    const warn=t=>{msg.className="save-msg error";msg.textContent=t;};
    save.onclick=()=>{
      if(!st.value)return warn("اختر الحالة: تم أو لم يتم.");
      if(!note.value)return warn("اختر الملاحظة من القائمة.");
      const text=note.value===NOTE_OTHER?other.value.trim():note.value;
      if(!text)return warn("اكتب الملاحظة في خانة «أخرى».");
      saveStatus(r.id,st.value==="done",text,save,msg);
    };
    wrap.append(st,note,other,save);container.append(wrap,msg);
  }
  function renderQueue(){
    const root=$("requestList");clear(root);buildTabs();
    const requesterView=queueMode==="mine";
    const queueTitle=document.querySelector("#queue h2");
    if(queueTitle)queueTitle.textContent=requesterView?"طلباتي":"معالجة الطلبات";
    const st=$("status");
    if(st?.options?.length>=3){
      st.options[1].textContent=requesterView?"لم يتم":"المفتوحة";
      st.options[2].textContent=requesterView?"تم":"المقفلة";
    }
    const qh=$("queueHint");
    if(qh)qh.textContent=requesterView
      ?"تعرض «طلباتي» الطلبات التي رفعتها أنت فقط. الحالة «تم» عند حجز الموعد، و«لم يتم» حتى يتم الحجز."
      :"المعيار التشغيلي 24 ساعة من وقت رفع الطلب. اختر «تم» أو «لم يتم» مع الملاحظة. «تم» يُقفل الطلب، و«لم يتم» يبقيه مفتوحاً إلا «طلب مكرر» و«لا تنطبق عليه ضوابط المسار».";
    const term=$("q").value.trim().toLowerCase();
    const status=$("status").value;
    const rows=queueData.filter(r=>
      (!requesterView||r.requested_by===user?.id)&&
      (queueKind==="all"||r.kind===queueKind)&&
      (status==="all"||(requesterView
        ?(status==="open"?r.status!=="booked":r.status==="booked")
        :(status==="open"?!statusClosed(r.status):statusClosed(r.status))))&&
      (!term||[r.patient_name,r.patient_identifier,r.source_facility,r.clinic_name,r.id].some(x=>String(x||"").toLowerCase().includes(term)))
    );
    if(!rows.length)root.append(el("p","لا توجد طلبات مطابقة.", "muted"));
    const canManage=handler();
    for(const r of rows){
      const card=el("article",undefined,"request"),top=el("div",undefined,"top");
      const heading=el("strong",(names[r.kind]||r.kind)+" — "+r.patient_name);
      const late=!statusClosed(r.status)&&hoursUntilNow(r.created_at)>24;
      const requesterView=queueMode==="mine";
      const isDone=r.status==="booked";
      const statusText=(isDone?"تم":"لم يتم")+(!requesterView&&late?" — متأخر":"");
      const statusClass=(isDone?"chip done":"chip notdone")+(!requesterView&&late?" late":"");
      top.append(heading,el("span",statusText,statusClass));
      card.append(top);
      card.append(el("p","الجهة: "+(r.source_facility||"غير محددة")+
        " | العيادة: "+r.clinic_name+(r.doctor_name?" | الطبيب: "+r.doctor_name:"")+" | الطبيب الطالب: "+(r.referring_doctor||r.requester_name||"—"),"muted"));
      if(r.manual_fields?.length)card.append(el("p","إدخال يدوي: "+r.manual_fields.map(x=>MANUAL_LABEL[x]||x).join("، "),"hint"));
      card.append(el("p","وقت الطلب: "+new Date(r.created_at).toLocaleString("ar-SA")+
        " | المرجع: "+r.id.slice(0,8),"muted"));
      const extra=el("details");const summary=el("summary","تفاصيل المريض وسبب الطلب");extra.append(summary);
      for(const [caption,value] of [
        ["رقم الهوية",r.patient_identifier],["تاريخ الميلاد",r.patient_dob],
        ["الجوال",r.patient_mobile],["اسم الأم",r.mother_name],
        ["السبب/التشخيص",r.diagnosis_reason],["الملاحظات",r.request_note]
      ])if(value)extra.append(el("p",caption+": "+value,"muted"));
      card.append(extra);
      if(!requesterView){
        const n=r.handler_note||r.rejection_reason||(isDone&&r.booked_date?"تاريخ الموعد: "+r.booked_date:"");
        if(n)card.append(el("p","الملاحظة: "+n,isDone?"success":"muted"));
        if(statusClosed(r.status)&&!isDone)card.append(el("p","الطلب مُقفل.","hint"));
      }
      if(queueMode==="manage"&&canManage&&!statusClosed(r.status))actionBox(r,card);
      root.append(card);
    }
    if(queueHasMore){
      const more=el("button","عرض المزيد","alt");more.onclick=()=>loadQueue(false);root.append(more);
    }
    if(queueData.length>=200)root.append(el("p","للتحقق من النتائج القديمة استخدم التصفية ثم «عرض المزيد».","hint"));
  }
  let queueSeq=0;
  async function loadQueue(reset){
    if(queueBusy&&!reset)return;queueBusy=true;
    const seq=++queueSeq,mode=queueMode;
    if(reset){queueOffset=0;queueData=[];queueHasMore=true;}
    let query=api.from("opd_appt_requests")
      .select("id,kind,requested_by,doctor_name,manual_fields,patient_name,patient_identifier,patient_dob,patient_mobile,mother_name,diagnosis_reason,request_note,source_facility,clinic_name,referring_doctor,requester_name,status,created_at,closed_at,booked_date,rejection_reason,handler_note")
      .order("created_at",{ascending:false}).range(queueOffset,queueOffset+199);
    if(queueMode==="mine")query=query.eq("requested_by",user.id);
    const r=await query;
    // نتيجة متأخرة من قسم سابق (طلباتي/المعالجة) تُتجاهل حتى لا تختلط الواجهتان
    if(seq!==queueSeq||mode!==queueMode)return;
    queueBusy=false;
    if(r.error)return feedback("queueMessage",r.error.message);
    queueData.push(...(r.data||[]));
    queueOffset+=r.data?.length||0;
    queueHasMore=(r.data?.length||0)===200;
    renderQueue();
  }
  function statCard(title,value){
    const n=el("div",undefined,"stat");n.append(el("span",title),el("b",value));return n;
  }
  function drawStats(data){
    lastReport=data;
    const root=$("statCards");clear(root);
    const vals=data?.totals||{};
    for(const [title,k] of [["إجمالي الطلبات","total"],["المحجوزة","booked"],
      ["خلال 24 ساعة","within_24"],["المتأخرة المفتوحة","overdue"],["المرفوضة","rejected"],["السجلات التاريخية","historical"]])
      root.append(statCard(title,String(vals[k]??"—")));
    if(Number(data?.previous_total||0)>0)root.append(statCard("التغير عن الفترة السابقة",
      (((Number(vals.total||0)-Number(data.previous_total))/Number(data.previous_total))*100).toFixed(1)+"%"));
    if(Number(vals.eligible_24||0)>0)root.append(statCard("الالتزام خلال 24 ساعة",
      (100*Number(vals.within_24||0)/Number(vals.eligible_24)).toFixed(1)+"%"));
    if(vals.mean_booking_hours!=null)root.append(statCard("متوسط إنجاز الحجز",vals.mean_booking_hours+" ساعة"));
    if(vals.mean_wait_days!=null)root.append(statCard("متوسط انتظار الموعد",vals.mean_wait_days+" يوم"));
    const box=$("statBreakdown");clear(box);
    box.append(el("p","مؤشر 24 ساعة يُحسب للسجلات ذات وقت إغلاق موثّق فقط؛ لا نختلق زمن إنجاز لردود Google القديمة.","hint"));
    for(const [group,title] of [["by_route","حسب المسار"],["by_facility","حسب الجهة"],
      ["by_clinic","حسب العيادة"],["by_doctor","حسب الطبيب"],["by_employee","إنتاجية موظفي المواعيد"],["by_rejection_reason","أسباب الرفض"],["by_month","حسب الشهر"]]){
      const h=el("h3",title);box.append(h);
      const a=data?.[group]||[];
      if(!a.length)box.append(el("p","لا توجد بيانات.","hint"));
      for(const x of a.slice(0,100)){
        const line=el("div",undefined,"request");
        line.textContent=(x.name||"غير محدد")+" — "+x.total;
        box.append(line);
      }
    }
  }
  async function stats(){
    lastReport=null;clear($("statCards"));clear($("statBreakdown"));
    const r=await api.rpc("opd_booking_dashboard",{p_from:$("statsFrom").value,p_to:$("statsTo").value});
    if(r.error)return $("statBreakdown").append(el("p","لم تُفعّل بعد خدمة إحصائيات الحجز الشاملة: "+r.error.message,"hint"));
    drawStats(r.data||{});
  }
  async function manualAlerts(){
    const r=await api.rpc("opd_booking_manual_alerts");
    const box=$("manualBox"),root=$("manualAlerts");
    if(r.error){box.classList.add("hidden");return 0;}
    box.classList.remove("hidden");clear(root);
    const rows=r.data||[];
    $("navSettings").textContent="التحكم بالخدمات"+(rows.length?" ("+rows.length+")":"");
    if(!rows.length)root.append(el("p","لا توجد تنبيهات.","hint"));
    for(const a of rows){
      const line=el("div",undefined,"request");
      line.append(el("strong",(names[a.kind]||a.kind)+" — "+new Date(a.created_at).toLocaleString("ar-SA")));
      for(const fld of a.manual_fields||[]){
        const v=fld==="facility"?a.source_facility:fld==="clinic"?a.clinic_name:a.doctor_name;
        line.append(el("p",MANUAL_LABEL[fld]+" مكتوب يدويًا: «"+(v||"")+"»"+(fld==="doctor"?" — العيادة: "+a.clinic_name:""),"muted"));
      }
      line.append(el("p","مقدّم الطلب: "+(a.requester_name||"—")+" | المرجع: "+String(a.id).slice(0,8),"muted"));
      const b=el("button","تمت المراجعة","alt");
      b.onclick=async()=>{b.disabled=true;const x=await api.rpc("opd_booking_manual_review",{p_id:a.id});
        if(x.error){b.disabled=false;return feedback("settingsMessage",x.error.message);}await manualAlerts();};
      line.append(b);root.append(line);
    }
    return rows.length;
  }
  async function settingsPanel(){
    manualAlerts();
    const r=await api.from("opd_booking_route_settings").select("kind,enabled").order("kind");
    const root=$("settingRows");clear(root);
    if(r.error){root.textContent=r.error.message;return;}
    for(const row of r.data||[]){
      const line=el("div",undefined,"request"),btn=el("button",row.enabled?"إيقاف":"تفعيل",row.enabled?"alt":"");
      line.append(el("strong",names[row.kind]||row.kind),el("span","  الحالة: "+(row.enabled?"مفعّل":"متوقف")+"  "));
      btn.onclick=async()=>{
        btn.disabled=true;
        const x=await api.from("opd_booking_route_settings")
          .update({enabled:!row.enabled,updated_at:new Date().toISOString(),updated_by:user.id})
          .eq("kind",row.kind).select("kind,enabled").single();
        btn.disabled=false;
        if(x.error){feedback("settingsMessage",x.error.message);return;}
        settings[row.kind]=x.data.enabled;
        drawForm();await settingsPanel();
      };
      line.append(btn);root.append(line);
    }
  }
  $("navNew").onclick=()=>panel("entry");
  $("navMine").onclick=()=>{queueMode="mine";panel("queue");loadQueue(true);};
  $("navQueue").onclick=()=>{queueMode="manage";panel("queue");loadQueue(true);};
  $("navStats").onclick=()=>{panel("stats");stats();};
  $("navSettings").onclick=()=>{panel("settings");settingsPanel();};
  $("status").onchange=renderQueue;$("q").oninput=renderQueue;
  $("refresh").onclick=()=>loadQueue(true);
  $("runStats").onclick=stats;
  function reportSections(){
    if(!lastReport)throw Error("اعرض المؤشرات أولًا قبل التحميل.");
    const v=lastReport.totals||{};
    const titles=[
      ["إجمالي الطلبات","total"],["تم الحجز","booked"],["خلال 24 ساعة","within_24"],
      ["المستحقة للمعيار","eligible_24"],["المتأخرة المفتوحة","overdue"],["المرفوضة","rejected"],
      ["السجلات التاريخية","historical"],["متوسط زمن إنجاز الحجز (ساعات)","mean_booking_hours"],
      ["متوسط مدة انتظار الموعد (أيام)","mean_wait_days"],["الفترة السابقة","previous_total"]
    ];
    const sections=[{title:"ملخص المؤشرات",headers:["المؤشر","القيمة"],
      rows:titles.map(([title,key])=>[title,key==="previous_total"?(lastReport.previous_total??0):(v[key]??"غير متاح")])}];
    for(const [key,title] of [
      ["by_route","حسب المسار"],["by_facility","حسب الجهة"],["by_clinic","حسب العيادة"],
      ["by_doctor","حسب الطبيب الطالب"],["by_employee","إنتاجية موظفي المواعيد"],
      ["by_rejection_reason","أسباب الرفض"],["by_month","حسب الشهر"]
    ])sections.push({title,headers:["الفئة","عدد الطلبات"],
      rows:(lastReport[key]||[]).map(x=>[String(x.name||"غير محدد"),Number(x.total||0)])});
    return sections;
  }
  const period=()=>$("statsFrom").value+" — "+$("statsTo").value;
  $("statsPdf").onclick=()=>{
    try{window.OPDExport.downloadPDF("تقرير طلبات الحجز",reportSections(),period());feedback("exportMessage","تم تجهيز تقرير PDF.",true)}
    catch(e){feedback("exportMessage",String(e.message||e));}
  };
  $("statsExcel").onclick=()=>{
    try{window.OPDExport.downloadExcel("تقرير طلبات الحجز",reportSections(),period());feedback("exportMessage","تم تجهيز تقرير Excel.",true)}
    catch(e){feedback("exportMessage",String(e.message||e));}
  };
  const date=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Riyadh"});
  $("statsTo").value=date;$("statsFrom").value=date.slice(0,8)+"01";
  load();
  api.auth.onAuthStateChange((event,session)=>{
    if(event==="SIGNED_OUT"){
      user=null;member=null;perms=new Set();showState("auth");
      return;
    }
    if(session&&!user)setTimeout(load,0);
  });
})();