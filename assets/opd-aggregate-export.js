/* Outpatient Clinics: self-contained aggregate-only XLSX and Arabic PDF reports.
   No patient-level records are accepted by reporting controls. */
(function(){
"use strict";
const ORG="العيادات الخارجية";
const FOOT="إعداد مدير العيادات الخارجية: خالد رميح الرميح";
const $enc=new TextEncoder();
function xml(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");}
function filename(t,ext){return String(t||"تقرير").replace(/[\\/:*?"<>|]/g,"").trim().slice(0,90)+"."+ext;}
function save(bytes,name,type){
 const blob=new Blob([bytes],{type});const url=URL.createObjectURL(blob);
 const a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function checked(sections){
 if(!Array.isArray(sections)||!sections.length)throw Error("لا تتوفر بيانات مجمعة للتصدير");
 return sections.map(s=>{
  const headers=(s.headers||[]).map(v=>String(v));
  if(headers.some(h=>/اسم المريض|اسم المراجع|رقم الهوية|رقم الملف|تاريخ ميلاد|patient.*name|patient.*id|patient.*file|mobile.*number|اسم الأم|mother.*name/i.test(h)))
    throw Error("تم منع تصدير بيانات المرضى الشخصية");
  const rows=(s.rows||[]).map(row=>(row||[]).map(v=>typeof v==="number"?v:String(v??"")));
  return {title:String(s.title||"مؤشرات"),headers,rows};
 });
}
function ascii(s){return $enc.encode(s);}
function concat(chunks){const total=chunks.reduce((s,b)=>s+b.length,0),out=new Uint8Array(total);let i=0;for(const b of chunks){out.set(b,i);i+=b.length;}return out;}
const CRC_TABLE=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(buf){let c=-1;for(const b of buf)c=CRC_TABLE[(c^b)&255]^(c>>>8);return(c^-1)>>>0;}
function zip(files){
 const local=[],central=[];let offset=0;
 for(const [path,value] of Object.entries(files)){
  const name=ascii(path),body=ascii(value),crc=crc32(body),l=new Uint8Array(30),v=new DataView(l.buffer);
  v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,2048,true);
  v.setUint32(14,crc,true);v.setUint32(18,body.length,true);v.setUint32(22,body.length,true);
  v.setUint16(26,name.length,true);local.push(l,name,body);
  const c=new Uint8Array(46),d=new DataView(c.buffer);
  d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,2048,true);
  d.setUint32(16,crc,true);d.setUint32(20,body.length,true);d.setUint32(24,body.length,true);
  d.setUint16(28,name.length,true);d.setUint32(42,offset,true);central.push(c,name);
  offset+=l.length+name.length+body.length;
 }
 const cd=concat(central),end=new Uint8Array(22),v=new DataView(end.buffer),n=Object.keys(files).length;
 v.setUint32(0,0x06054b50,true);v.setUint16(8,n,true);v.setUint16(10,n,true);
 v.setUint32(12,cd.length,true);v.setUint32(16,offset,true);
 return concat([...local,cd,end]);
}
function colName(i){let s="";for(i++;i;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s;}
function cells(row,idx,style){
 return '<row r="'+idx+'">'+row.map((v,j)=>{
  const coord=colName(j)+idx,styl=' s="'+style+'"';
  if(typeof v==="number"&&Number.isFinite(v))return'<c r="'+coord+'"'+styl+'><v>'+v+'</v></c>';
  const str=xml(v);
  return'<c r="'+coord+'" t="inlineStr"'+styl+'><is><t xml:space="preserve">'+str+'</t></is></c>';
 }).join("")+'</row>';
}
function sheetXml(section,period){
 let rows=[],r=1;
 rows.push(cells([ORG],r++,1));rows.push(cells([section.title],r++,1));
 rows.push(cells(["الفترة: "+String(period||"جميع الفترات")],r++,0));
 rows.push(cells([FOOT],r++,0));r++;
 if(section.headers.length)rows.push(cells(section.headers,r++,2));
 for(const row of section.rows)rows.push(cells(row,r++,0));
 return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
 '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
 '<sheetViews><sheetView workbookViewId="0" rightToLeft="1"/></sheetViews>'+
 '<sheetFormatPr defaultRowHeight="20"/><cols>'+
 Array.from({length:Math.max(section.headers.length,2)},(_,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+(i===0?34:22)+'" customWidth="1"/>').join("")+
 '</cols><sheetData>'+rows.join("")+'</sheetData></worksheet>';
}
function excel(title,sections,period){
 const data=checked(sections),sheets=data.map((s,i)=>({name:(s.title.replace(/[\\/*?:\[\]]/g,"").slice(0,25)||"تقرير")+" "+(i+1),xml:sheetXml(s,period)}));
 const files={
 "[Content_Types].xml":'<?xml version="1.0" encoding="UTF-8"?>'+
 '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
 '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
 '<Default Extension="xml" ContentType="application/xml"/>'+
 '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
 '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+
 sheets.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("")+'</Types>',
 "_rels/.rels":'<?xml version="1.0" encoding="UTF-8"?>'+
 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
 "xl/workbook.xml":'<?xml version="1.0" encoding="UTF-8"?>'+
 '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'+
 '<sheets>'+sheets.map((s,i)=>'<sheet name="'+xml(s.name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join("")+'</sheets></workbook>',
 "xl/_rels/workbook.xml.rels":'<?xml version="1.0" encoding="UTF-8"?>'+
 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
 sheets.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join("")+
 '<Relationship Id="rId'+(sheets.length+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
 "xl/styles.xml":'<?xml version="1.0" encoding="UTF-8"?>'+
 '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
 '<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="12"/><name val="Arial"/><color rgb="FF0B515B"/></font></fonts>'+
 '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE1EFF1"/><bgColor indexed="64"/></patternFill></fill></fills>'+
 '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'+
 '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+
 '<cellXfs count="3"><xf fontId="0" fillId="0" borderId="0" xfId="0"/>'+
 '<xf fontId="1" fillId="0" borderId="0" xfId="0"/>'+
 '<xf fontId="1" fillId="2" borderId="0" xfId="0"/></cellXfs></styleSheet>'
 };
 sheets.forEach((s,i)=>files["xl/worksheets/sheet"+(i+1)+".xml"]=s.xml);
 save(zip(files),filename(title,"xlsx"),"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
function pageCanvas(){
 const canvas=document.createElement("canvas");canvas.width=1240;canvas.height=1754;
 const ctx=canvas.getContext("2d");ctx.fillStyle="#ffffff";ctx.fillRect(0,0,canvas.width,canvas.height);
 ctx.direction="rtl";ctx.textBaseline="middle";return {canvas,ctx};
}
function pdf(title,sections,period){
 const data=checked(sections);
 const pages=[];let obj=pageCanvas(),y=245,sectionName="";
 const H=1754,W=1240,RIGHT=1160,LEFT=80;
 const header=()=>{
  const {ctx}=obj;
  ctx.fillStyle="#0b515b";ctx.fillRect(0,0,W,126);
  ctx.fillStyle="#fff";ctx.font="bold 42px Tahoma,Arial,sans-serif";ctx.textAlign="right";ctx.fillText(ORG,RIGHT,64);
  ctx.fillStyle="#153b44";ctx.font="bold 34px Tahoma,Arial,sans-serif";ctx.fillText(title,RIGHT,175);
  ctx.fillStyle="#637c84";ctx.font="23px Tahoma,Arial,sans-serif";ctx.fillText(String(period||"جميع الفترات"),RIGHT,218);
 };
 const finish=()=>{
  const {ctx}=obj;ctx.fillStyle="#edf4f5";ctx.fillRect(0,H-100,W,100);
  ctx.fillStyle="#244650";ctx.font="22px Tahoma,Arial,sans-serif";ctx.textAlign="right";ctx.fillText(FOOT,RIGHT,H-51);
  pages.push(obj.canvas);obj=pageCanvas();y=245;header();
 };
 header();
 const fit=(s,max)=>{let v=String(s??"");const {ctx}=obj;while(v.length>2&&ctx.measureText(v).width>max)v=v.slice(0,-2);return v.length<String(s??"").length?v+"…":v;};
 function heading(s){
  if(y>H-250)finish();
  const {ctx}=obj;ctx.fillStyle="#e4f0f1";ctx.fillRect(LEFT,y,W-LEFT*2,59);
  ctx.fillStyle="#0b515b";ctx.font="bold 29px Tahoma,Arial,sans-serif";ctx.textAlign="right";ctx.fillText(fit(s,W-LEFT*2-30),RIGHT-12,y+31);
  y+=69;
 }
 function tableLine(row,cols,head=false){
  if(y>H-150)finish();
  const {ctx}=obj;ctx.fillStyle=head?"#d5e8ea":(Math.floor(y/54)%2===0?"#f7fafb":"#fff");
  ctx.fillRect(LEFT,y,W-LEFT*2,53);
  ctx.fillStyle=head?"#0b515b":"#233e45";ctx.font=(head?"bold ":"")+"22px Tahoma,Arial,sans-serif";
  const width=(W-LEFT*2)/cols;ctx.textAlign="right";
  for(let i=0;i<cols;i++){
   const text=fit((row||[])[i]??"",width-20);
   ctx.fillText(text,RIGHT-i*width-12,y+27);
  }
  y+=54;
 }
 for(const section of data){
  heading(section.title);
  const headers=section.headers.length?section.headers:["القيمة"];
  tableLine(headers,headers.length,true);
  if(!section.rows.length)tableLine(["لا توجد بيانات"],headers.length);
  for(const row of section.rows){if(y>H-165){finish();heading(section.title+" (تابع)");tableLine(headers,headers.length,true);}
   tableLine(row,headers.length);
  }
  y+=20;
 }
 finish();
 const objects=new Map(),ids=[];
 objects.set(1,ascii("<< /Type /Catalog /Pages 2 0 R >>"));
 for(let i=0;i<pages.length;i++){
  const pageId=3+i*3,contentId=pageId+1,imageId=pageId+2;ids.push(pageId);
  const binary=atob(pages[i].toDataURL("image/jpeg",0.87).split(",")[1]),jpg=new Uint8Array(binary.length);
  for(let k=0;k<binary.length;k++)jpg[k]=binary.charCodeAt(k);
  const media="<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 "+imageId+" 0 R >> >> /Contents "+contentId+" 0 R >>";
  const draw=ascii("q 595.28 0 0 841.89 0 0 cm /Im0 Do Q");
  objects.set(pageId,ascii(media));
  objects.set(contentId,concat([ascii("<< /Length "+draw.length+" >>\nstream\n"),draw,ascii("\nendstream")]));
  objects.set(imageId,concat([ascii("<< /Type /XObject /Subtype /Image /Width "+pages[i].width+" /Height "+pages[i].height+" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length "+jpg.length+" >>\nstream\n"),jpg,ascii("\nendstream")]));
 }
 objects.set(2,ascii("<< /Type /Pages /Count "+ids.length+" /Kids ["+ids.map(id=>id+" 0 R").join(" ")+"] >>"));
 const parts=[ascii("%PDF-1.4\n%PDF-REPORT\n")],offsets=[0];let pos=parts[0].length;
 const count=2+pages.length*3;
 for(let i=1;i<=count;i++){
  offsets[i]=pos;
  const bytes=concat([ascii(i+" 0 obj\n"),objects.get(i),ascii("\nendobj\n")]);
  parts.push(bytes);pos+=bytes.length;
 }
 const xref=pos;let tail="xref\n0 "+(count+1)+"\n0000000000 65535 f \n";
 for(let i=1;i<=count;i++)tail+=String(offsets[i]).padStart(10,"0")+" 00000 n \n";
 tail+="trailer\n<< /Size "+(count+1)+" /Root 1 0 R >>\nstartxref\n"+xref+"\n%%EOF";
 parts.push(ascii(tail));
 save(concat(parts),filename(title,"pdf"),"application/pdf");
}
window.OPDExport={downloadExcel:excel,downloadPDF:pdf,header:ORG,footer:FOOT};
})();
