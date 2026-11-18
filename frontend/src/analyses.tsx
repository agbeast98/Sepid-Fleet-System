import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from './api';
import { Icon } from './shell';
import { PersianDateInput } from './persian-date';
type Machine = { id: string; code: string; plate:string|null; type:string|null; model_name:string|null; active:boolean; driver_id: string | null; supervisor_id:string|null; pm_id: string | null; floating_driver:boolean };
type Person = { id: string; name: string; role: 'driver' | 'supervisor' | 'pm' };
type RepairOption={id:string;machine_id:string;number:string;title:string;stage:string;result:'pass'|'fail'|null};
type ActionRule = { min: number; max: number | null; action: string };
type AnalysisRules = Record<'driver'|'pm', Record<'low'|'mid'|'high', ActionRule[]>>;
type AnalysisOptions = { machines: Machine[]; people: Person[]; repairs:RepairOption[]; rules: AnalysisRules; countWindow: 'all'|'year'|'12m' };
type Analysis = { id:string; machine_id:string; machine_code:string; analysis_date:string; topic:string; cause:string; severity:string;
  responses:Record<string,unknown>; goldratt:Record<string,string>; note:string; created_at:string; repair_id?:string|null; has_repair_link?:boolean; repair_number?:string|null; repair_title?:string|null };
const severityLabels:Record<string,string>={low:'کم اهمیت',medium:'نیمه حساس',high:'خیلی حساس'};
const resultLabels:Record<string,string>={none:'بدون سهل‌انگاری',driver:'سهل‌انگاری راننده',pm:'سهل‌انگاری مسئول PM',both:'سهل‌انگاری مشترک'};
const analysisSteps=[['مشخصات خرابی','file-text'],['بررسی راننده','user'],['بررسی مسئول PM','user-cog'],['فشار به دستگاه','gauge'],['تحلیل علت (گلدرات)','git-fork'],['سطح حساسیت','signal'],['نتیجه و ثبت','clipboard-check']] as const;
const dateFmt=new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium',timeZone:'UTC'});
const persianYear=new Intl.DateTimeFormat('en-US-u-ca-persian',{year:'numeric',timeZone:'Asia/Tehran'});
const htmlEscape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]??char));
const todayTehran=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Asia/Tehran',calendar:'gregory'}).formatToParts(new Date()).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
function AnalysisResultBadge({item}:{item:Analysis}){
  const result=analysisResult(item);
  const icon=result==='none'?'circle-check':result==='both'?'users':result==='pm'?'user-cog':'user';
  return <span className={`rpill rpill-${result}`}><Icon name={icon}/>{resultLabels[result]}</span>;
}
function AnalysisSeverityBadge({severity}:{severity:string}){
  const level=severity==='medium'?'mid':severity;
  return <span className={`sev sev-${level}`}><i/>{severityLabels[severity]??severity}</span>;
}
function YesNoChoices({name,value,onChange,yesHint,noHint}:{name:string;value:string;onChange:(value:string)=>void;yesHint:string;noHint:string}){
  return <div className="analysis-yn-choices">{([{value:'yes',label:'بله',hint:yesHint,icon:'check'},{value:'no',label:'خیر',hint:noHint,icon:'x'}] as const).map(option=><label className={`analysis-yn-choice ${value===option.value?`selected ${option.value}`:''}`} key={option.value}><input className="visually-hidden" type="radio" name={name} value={option.value} required checked={value===option.value} onChange={()=>onChange(option.value)}/><span className="analysis-yn-icon"><Icon name={option.icon}/></span><span><b>{option.label}</b><small>{option.hint}</small></span></label>)}</div>;
}
function analysisResult(item: Analysis): string {
  const driver=item.responses.q1==='yes'&&item.responses.q1b==='no';
  const pm=item.responses.q2==='yes'&&item.responses.q2b==='no';
  return driver&&pm?'both':driver?'driver':pm?'pm':'none';
}
function normalizeDriverName(value:unknown):string{return typeof value==='string'?value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('fa'):'';}
export function Analyses({startNew,onQuickComplete,canEdit=true,quickRepairId,onOpenRepair}:{startNew:boolean;onQuickComplete:()=>void;canEdit?:boolean;quickRepairId?:string|null;onOpenRepair?:(id:string)=>void}) {
  const [items,setItems]=useState<Analysis[]>([]);
  const [machines,setMachines]=useState<Machine[]>([]);
  const [people,setPeople]=useState<Person[]>([]);
  const [repairs,setRepairs]=useState<RepairOption[]>([]);
  const [rules,setRules]=useState<AnalysisRules|null>(null);
  const [countWindow,setCountWindow]=useState<AnalysisOptions['countWindow']>('all');
  const [machineId,setMachineId]=useState('');
  const [driverId,setDriverId]=useState('');
  const [driverName,setDriverName]=useState('');
  const [pmId,setPmId]=useState('');
  const [supervisorId,setSupervisorId]=useState('');
  const [repairId,setRepairId]=useState('');
  const [queuedRepairId,setQueuedRepairId]=useState<string|null>(null);
  const [open,setOpen]=useState(false);
  const [selected,setSelected]=useState<Analysis|null>(null);
  const [editing,setEditing]=useState<Analysis|null>(null);
  const [driverAware,setDriverAware]=useState('');
  const [driverReported,setDriverReported]=useState('');
  const [pmAware,setPmAware]=useState('');
  const [pmReported,setPmReported]=useState('');
  const [pressureAware,setPressureAware]=useState('');
  const [pressureNote,setPressureNote]=useState('');
  const [analysisStep,setAnalysisStep]=useState(0);
  const [formSeverity,setFormSeverity]=useState('');
  const [reviewData,setReviewData]=useState<Record<string,string>|null>(null);
  const [query,setQuery]=useState('');
  const selectedMachine=machines.find(item=>item.id===machineId);
  const selectedRepair=repairs.find(item=>item.id===repairId);
  const selectableMachines=machines.filter(item=>item.active||item.id===editing?.machine_id);
  function scheduleAnalysisAdvance(step:number,reviewForm?:HTMLFormElement){
    window.setTimeout(()=>{
      if(reviewForm){
        const values=Object.fromEntries(Array.from(new FormData(reviewForm).entries(),([key,value])=>[key,String(value)]));
        values.driver_id=driverId;values.driver_name=driverName;values.supervisor_id=supervisorId;values.pm_id=pmId;values.q3=pressureAware;values.q3note=pressureNote;
        setReviewData(values);
      }
      setAnalysisStep(current=>current===step?step+1:current);
    },step===5?380:420);
  }
  const driverLabel=(item:Analysis)=>typeof item.responses.driver_name==='string'&&item.responses.driver_name.trim()
    ?item.responses.driver_name.trim():people.find(person=>person.id===item.responses.driver_id)?.name??'ثبت نشده';
  const [machine,setMachine]=useState('');
  const [severity,setSeverity]=useState('');
  const [result,setResult]=useState('');
  const [from,setFrom]=useState('');
  const [to,setTo]=useState('');
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState('');
  async function refresh(){
    setBusy(true);setError('');
    try{const [list,options]=await Promise.all([api<Analysis[]>('/analyses'),api<AnalysisOptions>('/analyses/options')]);setItems(list);setMachines(options.machines);setPeople(options.people);setRepairs(options.repairs??[]);setRules(options.rules);setCountWindow(options.countWindow);const firstActive=options.machines.find(item=>item.active);if(!machineId&&firstActive){setMachineId(firstActive.id);setDriverId(firstActive.driver_id??'');setSupervisorId(firstActive.supervisor_id??'');setPmId(firstActive.pm_id??'');}}
    catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}
  }
  useEffect(()=>{void refresh();},[]);
  useEffect(()=>{if(startNew){setEditing(null);setDriverAware('');setDriverReported('');setPmAware('');setPmReported('');setPressureAware('');setPressureNote('');setFormSeverity('');setAnalysisStep(0);setReviewData(null);setRepairId('');setQueuedRepairId(quickRepairId??null);setOpen(true);const firstActive=machines.find(item=>item.active);if(!quickRepairId&&firstActive){setMachineId(firstActive.id);setDriverId(firstActive.driver_id??'');setDriverName('');setSupervisorId(firstActive.supervisor_id??'');setPmId(firstActive.pm_id??'');}onQuickComplete();}},[startNew]);
  useEffect(()=>{if(!queuedRepairId||!repairs.length)return;const linked=repairs.find(item=>item.id===queuedRepairId);if(linked){const machine=machines.find(item=>item.id===linked.machine_id);setMachineId(linked.machine_id);setRepairId(linked.id);setDriverId(machine?.driver_id??'');setDriverName('');setSupervisorId(machine?.supervisor_id??'');setPmId(machine?.pm_id??'');}setQueuedRepairId(null);},[queuedRepairId,repairs,machines]);
  function openEdit(item:Analysis){
    setEditing(item);setMachineId(item.machine_id);
    setFormSeverity(item.severity);
    setDriverId(typeof item.responses.driver_id==='string'?item.responses.driver_id:'');
    setDriverName(typeof item.responses.driver_name==='string'?item.responses.driver_name:people.find(person=>person.id===item.responses.driver_id)?.name??'');
    setSupervisorId(typeof item.responses.supervisor_id==='string'?item.responses.supervisor_id:'');
    setPmId(typeof item.responses.pm_id==='string'?item.responses.pm_id:'');
    setRepairId(item.repair_id??'');
    setDriverAware(typeof item.responses.q1==='string'?item.responses.q1:'');setDriverReported(typeof item.responses.q1b==='string'?item.responses.q1b:'');
    setPmAware(typeof item.responses.q2==='string'?item.responses.q2:'');setPmReported(typeof item.responses.q2b==='string'?item.responses.q2b:'');
    setPressureAware(typeof item.responses.q3==='string'?item.responses.q3:'');
    setPressureNote(typeof item.responses.q3note==='string'?item.responses.q3note:'');
    setAnalysisStep(0);setReviewData(null);setOpen(true);setError('');
  }
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const current=event.currentTarget.querySelector<HTMLFieldSetElement>(`[data-analysis-step="${analysisStep}"]`);
    const invalid=current&&Array.from(current.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea')).find(field=>!field.checkValidity());
    if(invalid){invalid.reportValidity();return;}
    if(analysisStep<6){if(analysisStep===5){const values=Object.fromEntries(Array.from(new FormData(event.currentTarget).entries(),([key,value])=>[key,String(value)]));values.driver_id=driverId;values.driver_name=driverName;values.supervisor_id=supervisorId;values.pm_id=pmId;values.q3=pressureAware;values.q3note=pressureNote;setReviewData(values);}setAnalysisStep(step=>step+1);return;}
    const form=new FormData(event.currentTarget);setBusy(true);setError('');
    try {
      const responses={q1:form.get('q1'),q1b:form.get('q1b'),q2:form.get('q2'),q2b:form.get('q2b'),
        driver_id:driverId||null,driver_name:driverName.trim(),
        supervisor_id:supervisorId||null,pm_id:pmId||null,
        q3:pressureAware,q3note:pressureAware==='yes'?pressureNote.trim():''};
      const goldratt={ude:String(form.get('ude')||''),root:String(form.get('root')||''),change:String(form.get('change')||'')};
      const payload={machine_id:form.get('machine_id'),...(!editing?.has_repair_link||editing.repair_id?{repair_id:repairId||null}:{}),date:form.get('date'),topic:form.get('topic'),cause:form.get('cause'),severity:form.get('severity'),responses,goldratt,note:form.get('note')};
      const record=await api<Analysis>(editing?`/analyses/${encodeURIComponent(editing.id)}`:'/analyses',editing?'PATCH':'POST',payload);
      setItems(current=>editing?current.map(item=>item.id===record.id?record:item):[record,...current]);
      setSelected(record);setOpen(false);setEditing(null);
    }catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}
  }
  function goToAnalysisStep(target:number,form:HTMLFormElement){
    if(target>analysisStep){
      for(let index=0;index<target;index++){
        const section=form.querySelector<HTMLFieldSetElement>(`[data-analysis-step="${index}"]`);
        const invalid=section&&Array.from(section.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea')).find(field=>!field.checkValidity());
        if(invalid){setAnalysisStep(index);window.setTimeout(()=>invalid.reportValidity(),0);return;}
      }
    }
    setAnalysisStep(target);
  }
  const filtered=items.filter(item=>{
    const driver=driverLabel(item);
    const pm=people.find(person=>person.id===item.responses.pm_id)?.name??'';
    const linked=repairs.find(repair=>repair.id===item.repair_id);
    const supervisor=people.find(person=>person.id===item.responses.supervisor_id)?.name??'';
    const text=`${item.machine_code} ${item.repair_number??linked?.number??''} ${item.repair_title??linked?.title??''} ${item.topic} ${item.cause} ${driver} ${pm} ${supervisor} ${item.goldratt.ude} ${item.goldratt.root} ${item.goldratt.change} ${item.note} ${item.responses.q3note??''}`.toLocaleLowerCase('fa');
    const outcome=analysisResult(item);
    return (!query||text.includes(query.trim().toLocaleLowerCase('fa')))
      &&(!machine||item.machine_id===machine)&&(!severity||item.severity===severity)
      &&(!result||outcome===result)&&(!from||item.analysis_date>=from)&&(!to||item.analysis_date<=to);
  });
  function actionFor(item:Analysis,role:'driver'|'pm',includeCurrent=true):{count:number;action:string}|null{
    const personId=item.responses[role==='driver'?'driver_id':'pm_id'];
    const targetDriverName=role==='driver'&&!personId?normalizeDriverName(item.responses.driver_name):'';
    const neg=role==='driver'?(item.responses.q1==='yes'&&item.responses.q1b==='no'):(item.responses.q2==='yes'&&item.responses.q2b==='no');
    if((typeof personId!=='string'||!personId)&&!targetDriverName||!neg||!rules)return null;
    const severityKey=item.severity==='medium'?'mid':item.severity as 'low'|'mid'|'high';
    if(!['low','mid','high'].includes(severityKey))return null;
    const targetDate=item.analysis_date;
    const relevant=items.filter(candidate=>{
      if(candidate.id===item.id)return false;
      const samePerson=role==='driver'&&targetDriverName
        ?!candidate.responses.driver_id&&normalizeDriverName(candidate.responses.driver_name)===targetDriverName
        :candidate.responses[role==='driver'?'driver_id':'pm_id']===personId;
      if(!samePerson||candidate.severity!==item.severity)return false;
      const isNegative=role==='driver'?(candidate.responses.q1==='yes'&&candidate.responses.q1b==='no'):(candidate.responses.q2==='yes'&&candidate.responses.q2b==='no');
      if(!isNegative||candidate.analysis_date>targetDate||(candidate.analysis_date===targetDate&&candidate.created_at>item.created_at))return false;
      if(countWindow==='year'&&persianYear.format(new Date(candidate.analysis_date+'T00:00:00Z'))!==persianYear.format(new Date(targetDate+'T00:00:00Z')))return false;
      if(countWindow==='12m'){
        const days=(Date.parse(targetDate+'T00:00:00Z')-Date.parse(candidate.analysis_date+'T00:00:00Z'))/86400000;
        if(days<0||days>365)return false;
      }
      return true;
    });
    const count=relevant.length+(includeCurrent?1:0);
    const rule=rules[role]?.[severityKey]?.find(candidate=>count>=candidate.min&&(candidate.max===null||count<=candidate.max));
    return rule?.action?{count,action:rule.action}:null;
  }
  const reviewPreview:Analysis|null=reviewData?{
    id:editing?.id??'preview',machine_id:reviewData.machine_id??machineId,machine_code:machines.find(item=>item.id===(reviewData.machine_id??machineId))?.code??'—',
    analysis_date:reviewData.date??todayTehran(),topic:reviewData.topic??'',cause:reviewData.cause??'',severity:reviewData.severity??'',
    responses:{driver_id:reviewData.driver_id||null,driver_name:reviewData.driver_name??'',supervisor_id:reviewData.supervisor_id||null,pm_id:reviewData.pm_id||null,
      q1:reviewData.q1,q1b:reviewData.q1b,q2:reviewData.q2,q2b:reviewData.q2b,q3:reviewData.q3,q3note:reviewData.q3note},
    goldratt:{ude:reviewData.ude??'',root:reviewData.root??'',change:reviewData.change??''},note:reviewData.note??'',created_at:editing?.created_at??'9999-12-31T23:59:59.999Z',
  }:null;
  const reviewActions=reviewPreview?{driver:actionFor(reviewPreview,'driver',true),pm:actionFor(reviewPreview,'pm',true)}:null;
  const livePreview:Analysis={id:editing?.id??'live-preview',machine_id:machineId,machine_code:selectedMachine?.code??'—',analysis_date:todayTehran(),topic:'',cause:'',severity:formSeverity,
    responses:{driver_id:selectedMachine?.floating_driver?null:driverId||null,driver_name:driverName,supervisor_id:supervisorId||null,pm_id:pmId||null,q1:driverAware,q1b:driverReported,q2:pmAware,q2b:pmReported,q3:pressureAware,q3note:pressureNote},
    goldratt:{ude:'',root:'',change:''},note:'',created_at:editing?.created_at??'9999-12-31T23:59:59.999Z'};
  const liveActions=formSeverity?{driver:actionFor(livePreview,'driver',true),pm:actionFor(livePreview,'pm',true)}:null;
  function exportCsv(){
    const cell=(value:unknown)=>{
      let text=String(value??'');
      if(/^\s*[-=+@]/.test(text))text="'"+text;
      return `"${text.replaceAll('"','""')}"`;
    };
    const answer=(value:unknown)=>value==='yes'?'بله':value==='no'?'خیر':'';
    const rows=[['تاریخ','ماشین','پلاک/کد پرونده','موضوع','علت احتمالی','راننده','پاسخ راننده','گزارش راننده','سرپرست','مسئول PM','پاسخ PM','گزارش PM','فشار کاری','توضیح فشار کاری','اثر نامطلوب','علت ریشه‌ای','راهکار پیشنهادی','حساسیت','نتیجه','اقدام راننده','اقدام PM','یادداشت'],...filtered.map(item=>[
      dateFmt.format(new Date(item.analysis_date+'T00:00:00Z')),item.machine_code,item.repair_number??'',item.topic,item.cause,
      driverLabel(item),answer(item.responses.q1),answer(item.responses.q1b),
      people.find(person=>person.id===item.responses.supervisor_id)?.name??'',people.find(person=>person.id===item.responses.pm_id)?.name??'',answer(item.responses.q2),answer(item.responses.q2b),
      answer(item.responses.q3),String(item.responses.q3note??''),item.goldratt.ude,item.goldratt.root,item.goldratt.change,
      severityLabels[item.severity]??item.severity,resultLabels[analysisResult(item)],
      actionFor(item,'driver')?.action??'',actionFor(item,'pm')?.action??'',item.note,
    ])];
    const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='sepid-analysis-report.csv';link.click();URL.revokeObjectURL(url);
  }
  function printReport(){
    const popup=window.open('','_blank');if(!popup){setError('پنجرهٔ چاپ باز نشد؛ اجازهٔ بازشدن پنجره را در مرورگر فعال کنید.');return;}
    const answer=(value:unknown)=>value==='yes'?'بله':value==='no'?'خیر':'ثبت نشده';
    const filters=[query&&`جست‌وجو: ${query}`,machine&&`ماشین: ${machines.find(item=>item.id===machine)?.code??''}`,result&&`نتیجه: ${resultLabels[result]??result}`,severity&&`حساسیت: ${severityLabels[severity]??severity}`,from&&`از ${dateFmt.format(new Date(from+'T00:00:00Z'))}`,to&&`تا ${dateFmt.format(new Date(to+'T00:00:00Z'))}`].filter(Boolean).join(' · ')||'همهٔ تحلیل‌های در دسترس';
    const counts=Object.fromEntries(Object.keys(resultLabels).map(key=>[key,filtered.filter(item=>analysisResult(item)===key).length]));
    const cards=filtered.map(item=>{
      const driver=driverLabel(item);
      const supervisor=people.find(person=>person.id===item.responses.supervisor_id)?.name??'ثبت نشده';
      const pm=people.find(person=>person.id===item.responses.pm_id)?.name??'ثبت نشده';
      const responseRows=[['راننده',driver,'آیا علائم به صورتی بوده است که راننده متوجه آن شود؟',answer(item.responses.q1)],...(item.responses.q1==='yes'?[['راننده',driver,'آیا راننده گزارش خرابی را به مسئول ماشین‌آلات ارائه داده است؟',answer(item.responses.q1b)]]:[]),['مسئول PM',pm,'آیا علائم به صورتی بوده است که مسئول PM متوجه آن شود؟',answer(item.responses.q2)],...(item.responses.q2==='yes'?[['مسئول PM',pm,'آیا مسئول PM گزارش خرابی را به مسئول ماشین‌آلات ارائه داده است؟',answer(item.responses.q2b)]]:[]),['بررسی کلی','', 'آیا فشار به دستگاه می‌تواند یکی از علت‌های خرابی باشد؟',answer(item.responses.q3)],...(item.responses.q3note?[['بررسی کلی','','توضیح فشار کاری',String(item.responses.q3note)]]:[])];
      const actions=(['driver','pm'] as const).map(role=>{const action=actionFor(item,role);const person=role==='driver'?driver:pm;return action?`<div><b>${htmlEscape(role==='driver'?'اقدام راننده':'اقدام مسئول PM')} · ${htmlEscape(person)}</b><p>${htmlEscape(action.action)} <small>(${new Intl.NumberFormat('fa-IR').format(action.count)} مورد در سابقه)</small></p></div>`:''}).filter(Boolean).join('');
      return `<article class="analysis-card"><header><div><h2>${htmlEscape(item.topic)}</h2><span>${htmlEscape(item.machine_code)} · ${item.repair_number?`پروندهٔ ${htmlEscape(item.repair_number)} · `:''}${htmlEscape(dateFmt.format(new Date(item.analysis_date+'T00:00:00Z')))}</span></div><div>${htmlEscape(severityLabels[item.severity]??item.severity)} · ${htmlEscape(resultLabels[analysisResult(item)])}</div></header><dl><div><dt>علت احتمالی</dt><dd>${htmlEscape(item.cause||'—')}</dd></div><div><dt>راننده</dt><dd>${htmlEscape(driver)}</dd></div><div><dt>سرپرست</dt><dd>${htmlEscape(supervisor)}</dd></div><div><dt>مسئول PM</dt><dd>${htmlEscape(pm)}</dd></div></dl><table><thead><tr><th>نقش</th><th>پرسش</th><th>پاسخ</th></tr></thead><tbody>${responseRows.map(row=>`<tr><td>${htmlEscape(row[0])}${row[1]?` · ${htmlEscape(row[1])}`:''}</td><td>${htmlEscape(row[2])}</td><td>${htmlEscape(row[3])}</td></tr>`).join('')}</tbody></table>${item.goldratt.ude||item.goldratt.root||item.goldratt.change?`<h3>تحلیل علت و اقدام پیشنهادی</h3><dl>${item.goldratt.ude?`<div><dt>اثر نامطلوب</dt><dd>${htmlEscape(item.goldratt.ude)}</dd></div>`:''}${item.goldratt.root?`<div><dt>علت ریشه‌ای</dt><dd>${htmlEscape(item.goldratt.root)}</dd></div>`:''}${item.goldratt.change?`<div><dt>راهکار پیشنهادی</dt><dd>${htmlEscape(item.goldratt.change)}</dd></div>`:''}</dl>`:''}${actions?`<h3>اقدام مدیریتی بر اساس سابقه</h3>${actions}`:''}${item.note?`<p><b>یادداشت:</b> ${htmlEscape(item.note)}</p>`:''}</article>`;
    }).join('');
    popup.document.open();popup.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>گزارش تحلیل خرابی‌ها</title><style>@page{size:A4 portrait;margin:14mm}*{box-sizing:border-box}body{font:10px Tahoma,Arial,sans-serif;color:#172126;margin:0}body>header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #174e5a;padding-bottom:9px;margin-bottom:13px}h1{font-size:18px;color:#174e5a;margin:0 0 5px}h2{font-size:14px;margin:0 0 5px;color:#174e5a}h3{font-size:11px;color:#174e5a;margin:12px 0 6px}.muted,header span{color:#68767a}.summary{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin:10px 0 14px}.summary div{padding:7px;border:1px solid #d7dfe1;border-radius:4px}.summary b{display:block;margin-top:3px;font-size:14px}.analysis-card{break-inside:avoid;border:1px solid #ccd4d6;border-radius:6px;padding:12px;margin:0 0 12px}.analysis-card header{display:flex;justify-content:space-between;gap:10px;padding-bottom:7px;border-bottom:1px solid #d7dfe1;margin-bottom:8px}.analysis-card dl{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;margin:9px 0}.analysis-card dl div{padding:7px;background:#f6f8f8;border-radius:3px}.analysis-card dt{font-size:8px;color:#68767a}.analysis-card dd{margin:3px 0 0;white-space:pre-wrap;line-height:1.6}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d7dfe1;padding:5px;text-align:right}th{background:#edf2f3}.analysis-card p{line-height:1.7;white-space:pre-wrap}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:24px;text-align:center}.signatures div{border-top:1px solid #68777b;padding-top:6px}</style></head><body><header><div><h1>گزارش تحلیل خرابی‌ها</h1><span>${htmlEscape(filters)}</span></div><span>تاریخ تهیه: ${htmlEscape(dateFmt.format(new Date()))} · ${new Intl.NumberFormat('fa-IR').format(filtered.length)} تحلیل</span></header><section class="summary">${Object.entries(resultLabels).map(([key,label])=>`<div>${htmlEscape(label)}<b>${new Intl.NumberFormat('fa-IR').format(counts[key]??0)}</b></div>`).join('')}<div>همهٔ تحلیل‌ها<b>${new Intl.NumberFormat('fa-IR').format(filtered.length)}</b></div></section>${cards||'<p>تحلیلی برای چاپ وجود ندارد.</p>'}<section class="signatures"><div>تهیه‌کننده</div><div>مسئول ماشین‌آلات</div><div>مدیریت</div></section><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`);popup.document.close();
  }
  function printSelectedAnalysis(item:Analysis){
    const popup=window.open('','_blank');if(!popup){setError('پنجرهٔ چاپ باز نشد؛ اجازهٔ بازشدن پنجره را در مرورگر فعال کنید.');return;}
    const answer=(value:unknown)=>value==='yes'?'بله':value==='no'?'خیر':'ثبت نشده';
    const printedMachine=machines.find(machine=>machine.id===item.machine_id);
    const actions=(['driver','pm'] as const).flatMap(role=>{const action=actionFor(item,role);if(!action)return [];const personId=item.responses[role==='driver'?'driver_id':'pm_id'];const name=role==='driver'?driverLabel(item):people.find(person=>person.id===personId)?.name??'ثبت نشده';return [`<tr><td>${role==='driver'?'راننده':'مسئول PM'}</td><td>${htmlEscape(name)}</td><td>${new Intl.NumberFormat('fa-IR').format(action.count)}</td><td>${htmlEscape(action.action)}</td></tr>`];}).join('');
    const rows=[['راننده',driverLabel(item),'آیا علائم به صورتی بوده است که راننده متوجه آن شود؟',answer(item.responses.q1)],...(item.responses.q1==='yes'?[['راننده',driverLabel(item),'آیا راننده گزارش خرابی را به مسئول ماشین‌آلات ارائه داده است؟',answer(item.responses.q1b)]]:[]),['مسئول PM',people.find(person=>person.id===item.responses.pm_id)?.name??'ثبت نشده','آیا علائم به صورتی بوده است که مسئول PM متوجه آن شود؟',answer(item.responses.q2)],...(item.responses.q2==='yes'?[['مسئول PM',people.find(person=>person.id===item.responses.pm_id)?.name??'ثبت نشده','آیا مسئول PM گزارش خرابی را به مسئول ماشین‌آلات ارائه داده است؟',answer(item.responses.q2b)]]:[]),['بررسی کلی','','آیا فشار به دستگاه می‌تواند یکی از علت‌های خرابی باشد؟',answer(item.responses.q3)],...(item.responses.q3note?[['بررسی کلی','','توضیح فشار کاری',String(item.responses.q3note)]]:[])].map(row=>`<tr><td>${htmlEscape(row[0])}${row[1]?` · ${htmlEscape(row[1])}`:''}</td><td>${htmlEscape(row[2])}</td><td>${htmlEscape(row[3])}</td></tr>`).join('');
    const related=item.repair_id?`پروندهٔ مرتبط ${item.repair_number??''} · ${item.repair_title??''}`:'';
    popup.document.open();popup.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>فرم تحلیل خرابی</title><style>@page{size:A4 portrait;margin:14mm}*{box-sizing:border-box}body{font:10px Tahoma,Arial,sans-serif;color:#172126;line-height:1.7}header{display:flex;justify-content:space-between;border-bottom:2px solid #174e5a;padding-bottom:9px}h1{font-size:18px;color:#174e5a;margin:0}h2{font-size:13px;color:#174e5a;margin:15px 0 5px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;margin:12px 0}.grid div,.box{border:1px solid #d7dfe1;padding:7px;white-space:pre-wrap}.grid b{display:block;color:#68767a;font-size:8px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d7dfe1;padding:6px;text-align:right;vertical-align:top}th{background:#edf2f3}.sign{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:30px;text-align:center}.sign div{border-top:1px solid #68777b;padding-top:6px}</style></head><body><header><div><h1>فرم بررسی علائم خرابی</h1><span>${htmlEscape(dateFmt.format(new Date(item.analysis_date+'T00:00:00Z')))}</span></div><span>${htmlEscape(resultLabels[analysisResult(item)])} · ${htmlEscape(severityLabels[item.severity]??item.severity)}</span></header><section class="grid"><div><b>ماشین</b>${htmlEscape(item.machine_code)}</div><div><b>نوع / مدل</b>${htmlEscape(printedMachine?.type||'—')} · ${htmlEscape(printedMachine?.model_name||'—')}</div><div><b>پلاک</b>${htmlEscape(printedMachine?.plate||'بدون پلاک')}</div><div><b>تاریخ بررسی</b>${htmlEscape(dateFmt.format(new Date(item.analysis_date+'T00:00:00Z')))}</div><div><b>راننده</b>${htmlEscape(driverLabel(item))}</div><div><b>مسئول PM</b>${htmlEscape(people.find(person=>person.id===item.responses.pm_id)?.name??'ثبت نشده')}</div><div><b>سرپرست</b>${htmlEscape(people.find(person=>person.id===item.responses.supervisor_id)?.name??'ثبت نشده')}</div><div><b>سطح حساسیت</b>${htmlEscape(severityLabels[item.severity]??'—')}</div><div class="box"><b>موضوع خرابی</b>${htmlEscape(item.topic||'—')}</div><div class="box"><b>علت</b>${htmlEscape(item.cause||'—')}</div>${related?`<div class="box"><b>اعلام خرابی مرتبط</b>${htmlEscape(related)}</div>`:''}</section><h2>پرسش‌های بررسی</h2><table><thead><tr><th>#</th><th>پرسش</th><th>پاسخ</th></tr></thead><tbody>${rows}</tbody></table>${item.goldratt.ude||item.goldratt.root||item.goldratt.change?`<h2>تحلیل علت خرابی (روش گلدرات)</h2><table><tbody><tr><th>اثر نامطلوب</th><td>${htmlEscape(item.goldratt.ude||'—')}</td></tr><tr><th>علت ریشه‌ای</th><td>${htmlEscape(item.goldratt.root||'—')}</td></tr><tr><th>راهکار و اقدام اصلاحی</th><td>${htmlEscape(item.goldratt.change||'—')}</td></tr></tbody></table>`:''}<h2>نتیجه و اقدام مدیریتی</h2>${actions?`<table><thead><tr><th>سمت</th><th>نام</th><th>دفعه سهل‌انگاری</th><th>اقدام مدیریتی</th></tr></thead><tbody>${actions}</tbody></table>`:'<p>برای این خرابی اقدام مدیریتی لازم نیست.</p>'}${item.note?`<p><b>یادداشت:</b> ${htmlEscape(item.note)}</p>`:''}<section class="sign"><div>مسئول ماشین‌آلات</div><div>سرپرست</div><div>مدیریت</div></section><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`);popup.document.close();
  }
  return <section className={`page ${open?'analysis-open':''}`}>
    <header className="page-head"><div className="ph-text"><h1>{open?(editing?'ویرایش تحلیل خرابی':'ثبت تحلیل خرابی جدید'):'تحلیل‌های خرابی'}</h1><p>{open?'فرم بررسی علائم؛ با پاسخ به سؤال‌ها، نتیجه و اقدام مدیریتی مشخص می‌شود.':'فهرست همهٔ فرم‌های بررسی علائم خرابی و نتیجهٔ آن‌ها'}</p></div><div className="ph-actions" dir="ltr">
      {open?<button className="btn btn-ghost" onClick={()=>{setOpen(false);setEditing(null);}}>بازگشت به تحلیل‌ها</button>:<><button className="btn btn-primary" disabled={busy||!machines.some(item=>item.active)} onClick={()=>{const machine=machines.find(item=>item.active);setEditing(null);setMachineId(machine?.id??'');setDriverId(machine?.driver_id??'');setDriverName('');setSupervisorId(machine?.supervisor_id??'');setPmId(machine?.pm_id??'');setRepairId('');setDriverAware('');setDriverReported('');setPmAware('');setPmReported('');setPressureAware('');setPressureNote('');setFormSeverity('');setAnalysisStep(0);setReviewData(null);setOpen(true);}}>تحلیل جدید</button>
      <button className="btn btn-ghost" disabled={busy} onClick={printReport}>چاپ گزارش</button><button className="btn btn-ghost" disabled={busy} onClick={exportCsv}>خروجی اکسل (CSV)</button></>}
      </div></header>
    <section className={open?'analysis-form-panel':'analysis-list-content'}>
    {error&&<p role="alert">{error}</p>}
    {!open&&selected&&<article className="record analysis-detail" aria-label="جزئیات تحلیل">
      <div className="toolbar"><h3>{selected.topic} · {selected.machine_code}</h3><button type="button" onClick={()=>printSelectedAnalysis(selected)}>چاپ فرم تحلیل</button>{canEdit&&<button type="button" onClick={()=>openEdit(selected)}>ویرایش تحلیل</button>}<button type="button" onClick={()=>setSelected(null)}>بستن جزئیات</button></div>
      <div className={`analysis-review-summary result-${analysisResult(selected)}`}><div><small>نتیجهٔ تحلیل خرابی</small><AnalysisResultBadge item={selected}/></div><AnalysisSeverityBadge severity={selected.severity}/><span>{dateFmt.format(new Date(selected.analysis_date+'T00:00:00Z'))}</span></div>
      {selected.repair_id&&<div className="analysis-repair-link"><div><b>پروندهٔ خرابی مرتبط {selected.repair_number??repairs.find(repair=>repair.id===selected.repair_id)?.number??''}</b><small>{selected.repair_title||repairs.find(repair=>repair.id===selected.repair_id)?.title||'پروندهٔ پیوندخورده'}</small></div>{onOpenRepair&&<button type="button" onClick={()=>onOpenRepair(selected.repair_id!)}>بازکردن پروندهٔ خرابی</button>}</div>}
      <dl className="analysis-detail-facts"><div><dt>ماشین</dt><dd>{selected.machine_code}</dd></div><div><dt>راننده</dt><dd>{driverLabel(selected)}</dd></div><div><dt>سرپرست</dt><dd>{people.find(person=>person.id===selected.responses.supervisor_id)?.name??'ثبت نشده'}</dd></div><div><dt>مسئول PM</dt><dd>{people.find(person=>person.id===selected.responses.pm_id)?.name??'ثبت نشده'}</dd></div><div className="span2"><dt>موضوع خرابی</dt><dd>{selected.topic}</dd></div>{selected.cause&&<div className="span2"><dt>علت احتمالی</dt><dd>{selected.cause}</dd></div>}</dl>
      <h4>پاسخ‌های بررسی</h4><div className="analysis-answer-grid">
        <div><span>آیا علائم به صورتی بوده است که راننده متوجه آن شود؟</span><b>{selected.responses.q1==='yes'?'بله':selected.responses.q1==='no'?'خیر':'ثبت نشده'}</b></div>{selected.responses.q1==='yes'&&<div><span>آیا راننده گزارش خرابی را به مسئول ماشین‌آلات ارائه داده است؟</span><b>{selected.responses.q1b==='yes'?'بله':selected.responses.q1b==='no'?'خیر':'ثبت نشده'}</b></div>}
        <div><span>آیا علائم به صورتی بوده است که مسئول PM متوجه آن شود؟</span><b>{selected.responses.q2==='yes'?'بله':selected.responses.q2==='no'?'خیر':'ثبت نشده'}</b></div>{selected.responses.q2==='yes'&&<div><span>آیا مسئول PM گزارش خرابی را به مسئول ماشین‌آلات ارائه داده است؟</span><b>{selected.responses.q2b==='yes'?'بله':selected.responses.q2b==='no'?'خیر':'ثبت نشده'}</b></div>}
        <div><span>آیا فشار به دستگاه می‌تواند یکی از علت‌های خرابی باشد؟</span><b>{selected.responses.q3==='yes'?'بله':selected.responses.q3==='no'?'خیر':'ثبت نشده'}</b></div>{typeof selected.responses.q3note==='string'&&selected.responses.q3note&&<div className="span2"><span>توضیح فشار کاری</span><b>{selected.responses.q3note}</b></div>}
      </div>
      {(selected.goldratt.ude||selected.goldratt.root||selected.goldratt.change)&&<><h4>تحلیل علت و اقدام پیشنهادی</h4><dl className="analysis-detail-facts">{selected.goldratt.ude&&<div className="span2"><dt>اثر نامطلوب مشاهده‌شده</dt><dd>{selected.goldratt.ude}</dd></div>}{selected.goldratt.root&&<div className="span2"><dt>علت ریشه‌ای</dt><dd>{selected.goldratt.root}</dd></div>}{selected.goldratt.change&&<div className="span2"><dt>اقدام پیشنهادی</dt><dd>{selected.goldratt.change}</dd></div>}</dl></>}
      {selected.note&&<div className="analysis-detail-note"><b>یادداشت</b><p>{selected.note}</p></div>}
      <h4>اقدام مدیریتی بر اساس سابقهٔ تکرار</h4><div className="analysis-action-grid">
        {(['driver','pm'] as const).map(role=>{const action=actionFor(selected,role);const personId=selected.responses[role==='driver'?'driver_id':'pm_id'];const name=role==='driver'?driverLabel(selected):people.find(person=>person.id===personId)?.name??'مسئول PM';return <div className={`analysis-action-card ${action?'has-action':'no-action'}`} key={role}><small>{role==='driver'?'راننده':'مسئول PM'}</small><b>{name}</b>{action?<><span>{new Intl.NumberFormat('fa-IR').format(action.count)} مورد سهل‌انگاری با این حساسیت</span><strong>{action.action}</strong></>:<span>برای این پرونده اقدامی بر اساس قواعد فعلی ثبت نمی‌شود.</span>}</div>;})}
      </div>
    </article>}
    {!open&&!machines.length&&!busy&&!error&&<p>برای ثبت تحلیل، ابتدا ماشین تعریف کنید.</p>}
    {open&&<form className="record analysis-wizard wizard" key={editing?.id??'new-analysis'} noValidate onSubmit={save}>
      <aside className="wz-side">
        <ol className="wz-steps">{analysisSteps.map(([label,icon],index)=><li key={label} aria-current={index===analysisStep?'step':undefined} className={`${index===analysisStep?'cur':''} ${index<analysisStep?'done':''}`}>
          <button type="button" onClick={event=>{const form=event.currentTarget.form;if(form)goToAnalysisStep(index,form);}}><span className="ws-dot">{index<analysisStep?<Icon name="check"/>:new Intl.NumberFormat('fa-IR').format(index+1)}</span><span>{label}</span></button>
        </li>)}</ol>
        <div className="wz-live"><div className="wl-title">نتیجه تا این لحظه</div>
          {selectedMachine&&<div className="wl-machine"><Icon name="truck"/><b>{selectedMachine.code}</b>{selectedMachine.plate&&<span className="plate-tag">{selectedMachine.plate}</span>}</div>}
          {driverAware||pmAware?<AnalysisResultBadge item={livePreview}/>:<span className="muted small">پس از پاسخ به سؤال‌ها نمایش داده می‌شود</span>}
          {liveActions&&(liveActions.driver||liveActions.pm)&&<div className="wl-acts">{(['driver','pm'] as const).map(role=>{const action=liveActions[role];if(!action)return null;const person=role==='driver'?driverLabel(livePreview):people.find(item=>item.id===pmId)?.name??'مسئول PM';return <div className="wl-act" key={role}><span>{person}</span><small>بار {new Intl.NumberFormat('fa-IR').format(action.count)}</small><b>{action.action}</b></div>;})}</div>}
        </div>
      </aside>
      <section className="wz-main card">
        <div className="wz-head"><span className="wz-ic"><Icon name={analysisSteps[analysisStep][1]}/></span><div><small>مرحلهٔ {new Intl.NumberFormat('fa-IR').format(analysisStep+1)} از ۷</small><h2>{analysisSteps[analysisStep][0]}</h2></div><div className="wz-progress"><i style={{width:`${((analysisStep+1)/analysisSteps.length)*100}%`}}/></div></div>
        <div className="wz-body">
      <fieldset data-analysis-step="0" hidden={analysisStep!==0}><legend>مشخصات خرابی</legend><div className="fields">
        <div className="analysis-machine-section"><span className="analysis-machine-label">ماشین</span><div className="machine-pick">{selectableMachines.map(item=><label className={`machine-choice analysis-machine-choice ${machineId===item.id?'selected':''}`} key={item.id}><input className="visually-hidden" type="radio" name="machine_id" value={item.id} required checked={machineId===item.id} onChange={()=>{setMachineId(item.id);setDriverId(item.driver_id??'');setDriverName('');setSupervisorId(item.supervisor_id??'');setPmId(item.pm_id??'');setRepairId('');}}/><span className="analysis-machine-model">{item.model_name||'مدل ثبت نشده'} · {item.type||'نوع ثبت نشده'}</span><b>{item.code}</b><small>{item.floating_driver?'راننده متغیر':people.find(person=>person.id===item.driver_id)?.name??'راننده ثبت نشده'}</small></label>)}</div></div>
        {selectedRepair&&<div className="analysis-linked-notice"><Icon name="link"/><span>این تحلیل برای پروندهٔ خرابی <b>{selectedRepair.title}</b> ثبت می‌شود · پروندهٔ {selectedRepair.number}{selectedRepair.result?' · بایگانی':''}</span></div>}
        {editing?.has_repair_link&&!editing.repair_id&&<p>این تحلیل به پرونده‌ای پیوند دارد که دسترسی نمایش آن را ندارید؛ پیوند هنگام ذخیره حفظ می‌شود.</p>}
        <label>تاریخ بررسی<PersianDateInput name="date" required defaultValue={editing?.analysis_date??todayTehran()} /></label>
        <label>راننده<input list="analysis-driver-options" value={driverName||people.find(person=>person.id===driverId)?.name||''} onChange={event=>{const value=event.target.value;const match=people.find(person=>person.role==='driver'&&normalizeDriverName(person.name)===normalizeDriverName(value));setDriverId(match?.id??'');setDriverName(match?'':value);}} required={!!selectedMachine?.floating_driver} maxLength={150} /><datalist id="analysis-driver-options">{people.filter(person=>person.role==='driver').map(person=><option key={person.id} value={person.name}/>)}</datalist><small>{selectedMachine?.floating_driver?'این دستگاه رانندهٔ ثابت ندارد؛ نام رانندهٔ این نوبت را بنویسید یا انتخاب کنید.':'پیش‌فرض: رانندهٔ ثابت این ماشین؛ می‌توانید نام دیگری انتخاب یا وارد کنید.'}</small></label>
        <label>مسئول PM<select value={pmId} onChange={event=>setPmId(event.target.value)}><option value="">ثبت نشده</option>{people.filter(person=>person.role==='pm').map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
        <label>سرپرست<select value={supervisorId} onChange={event=>setSupervisorId(event.target.value)}><option value="">ثبت نشده</option>{people.filter(person=>person.role==='supervisor').map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
        <label>پروندهٔ خرابی مرتبط<select name="repair_id" value={repairId} onChange={event=>setRepairId(event.target.value)}><option value="">بدون پیوند</option>{repairs.filter(repair=>repair.machine_id===machineId).map(repair=><option key={repair.id} value={repair.id}>پروندهٔ {repair.number} · {repair.title}{repair.result?' · بایگانی':''}</option>)}</select></label>
        <label>موضوع خرابی<input name="topic" required maxLength={500} placeholder="مثلاً: داغ کردن موتور، شکستگی لولهٔ رادیاتور…" defaultValue={editing?.topic??''} /></label>
        <label>علت<textarea name="cause" maxLength={4000} rows={3} placeholder="علت ظاهری خرابی به تشخیص تعمیرکار…" defaultValue={editing?.cause??''} /></label>
      </div></fieldset>
      <fieldset data-analysis-step="1" hidden={analysisStep!==1}><legend>بررسی راننده</legend><div className="fields">
        <div className="analysis-question"><span className="q-num">۱</span><div className="analysis-question-main"><b>آیا علائم به صورتی بوده است که راننده متوجه آن شود؟</b><YesNoChoices name="q1" value={driverAware} onChange={value=>{setDriverAware(value);if(value==='no'){setDriverReported('');scheduleAnalysisAdvance(1);}}} yesHint="علائم قابل تشخیص بوده" noHint="علائم قابل تشخیص نبوده"/>{driverAware==='no'&&<p className="analysis-answer-hint good">علائم قابل تشخیص برای راننده نبوده؛ سهل‌انگاری راننده مطرح نیست.</p>}</div></div>
        {driverAware==='yes'&&<div className="analysis-question follow"><span className="q-num"><Icon name="corner-down-left"/></span><div className="analysis-question-main"><b>آیا راننده گزارش خرابی را به مسئول ماشین‌آلات ارائه داده است؟</b><YesNoChoices name="q1b" value={driverReported} onChange={value=>{setDriverReported(value);scheduleAnalysisAdvance(1);}} yesHint="گزارش داده است" noHint="گزارش نداده است"/>{driverReported==='no'&&<p className="analysis-answer-hint warning">راننده متوجه خرابی شده ولی اطلاع نداده است؛ این مورد سهل‌انگاری راننده محسوب می‌شود.</p>}</div></div>}
      </div></fieldset>
      <fieldset data-analysis-step="2" hidden={analysisStep!==2}><legend>بررسی مسئول PM</legend><div className="fields">
        <div className="analysis-question"><span className="q-num">۲</span><div className="analysis-question-main"><b>آیا علائم به صورتی بوده است که مسئول PM متوجه آن شود؟</b><YesNoChoices name="q2" value={pmAware} onChange={value=>{setPmAware(value);if(value==='no'){setPmReported('');scheduleAnalysisAdvance(2);}}} yesHint="علائم قابل تشخیص بوده" noHint="علائم قابل تشخیص نبوده"/>{pmAware==='no'&&<p className="analysis-answer-hint good">علائم قابل تشخیص برای مسئول PM نبوده؛ سهل‌انگاری PM مطرح نیست.</p>}</div></div>
        {pmAware==='yes'&&<div className="analysis-question follow"><span className="q-num"><Icon name="corner-down-left"/></span><div className="analysis-question-main"><b>آیا مسئول PM گزارش خرابی را به مسئول ماشین‌آلات ارائه داده است؟</b><YesNoChoices name="q2b" value={pmReported} onChange={value=>{setPmReported(value);scheduleAnalysisAdvance(2);}} yesHint="گزارش داده است" noHint="گزارش نداده است"/>{pmReported==='no'&&<p className="analysis-answer-hint warning">مسئول PM متوجه خرابی شده ولی اطلاع نداده است؛ این مورد سهل‌انگاری مسئول PM محسوب می‌شود.</p>}</div></div>}
      </div></fieldset>
      <fieldset data-analysis-step="3" hidden={analysisStep!==3}><legend>فشار به دستگاه</legend><div className="fields">
        <div className="analysis-question"><span className="q-num">۳</span><div className="analysis-question-main"><b>آیا فشار به دستگاه می‌تواند یکی از علت‌های خرابی باشد؟</b><YesNoChoices name="q3" value={pressureAware} onChange={value=>{setPressureAware(value);if(value!=='yes'){setPressureNote('');scheduleAnalysisAdvance(3);}}} yesHint="مثلاً اضافه‌بار یا کار خارج از توان" noHint="فشار غیرعادی نبوده"/></div></div>
        {pressureAware==='yes'&&<label>توضیحات تکمیلی<textarea name="q3note" rows={4} maxLength={1000} placeholder="نوع فشار، میزان بار، شرایط کار…" value={pressureNote} onChange={event=>setPressureNote(event.target.value)} /></label>}
      </div></fieldset>
      <fieldset data-analysis-step="4" hidden={analysisStep!==4}><legend>تحلیل علت خرابی (روش گلدرات)</legend><p>بر اساس فرایند تفکر گلدرات، سه پرسش کلیدی را پاسخ دهید. پر کردن این مرحله اختیاری است.</p><div className="fields">
        <label>چه چیزی باید تغییر کند؟ (اثر نامطلوب / آنچه دیده شد)<textarea name="ude" rows={3} maxLength={2000} defaultValue={editing?.goldratt.ude??''} /></label>
        <label>علت ریشه‌ای چیست؟ (زنجیره علت و معلول تا ریشه)<textarea name="root" rows={3} maxLength={2000} defaultValue={editing?.goldratt.root??''} /></label>
        <label>به چه چیزی و چگونه تغییر کند؟ (راهکار و اقدام اصلاحی)<textarea name="change" rows={3} maxLength={2000} defaultValue={editing?.goldratt.change??''} /></label>
      </div></fieldset>
      <fieldset data-analysis-step="5" hidden={analysisStep!==5}><legend>سطح حساسیت خرابی</legend><div className="analysis-severity-pick">{([{key:'low',label:'کم اهمیت',description:'خرابی جزئی با اثر محدود بر کار'},{key:'medium',label:'نیمه حساس',description:'خرابی با اثر قابل توجه بر کار یا هزینه'},{key:'high',label:'خیلی حساس',description:'خرابی جدی، پرهزینه یا خطرناک'}] as const).map(option=><label className={`analysis-severity-choice sev-${option.key}`} key={option.key}><input type="radio" name="severity" value={option.key} required checked={formSeverity===option.key} onChange={event=>{setFormSeverity(event.currentTarget.value);const form=event.currentTarget.form;if(form)scheduleAnalysisAdvance(5,form);}}/><span className="analysis-severity-bars"><i/><i/><i/></span><b>{option.label}</b><small>{option.description}</small></label>)}</div><div className="fields">
        <label>یادداشت تحلیل<textarea name="note" maxLength={4000} defaultValue={editing?.note??''} /></label>
      </div></fieldset>
      <fieldset data-analysis-step="6" hidden={analysisStep!==6}><legend>نتیجه و ثبت</legend>{reviewPreview&&<div className="analysis-wizard-review">
        <div className={`analysis-review-summary result-${analysisResult(reviewPreview)}`}><div><small>نتیجهٔ فرم تحلیل</small><AnalysisResultBadge item={reviewPreview}/></div><AnalysisSeverityBadge severity={reviewPreview.severity}/></div>
        {reviewActions&&(reviewActions.driver||reviewActions.pm)?<div className="analysis-action-grid">{(['driver','pm'] as const).map(role=>{const action=reviewActions[role];const personId=reviewPreview.responses[role==='driver'?'driver_id':'pm_id'];const person=role==='driver'?driverLabel(reviewPreview):people.find(item=>item.id===personId)?.name??'مسئول PM';return action?<div className="analysis-action-card has-action" key={role}><small>{role==='driver'?'راننده':'مسئول PM'}</small><b>{person}</b><span>{new Intl.NumberFormat('fa-IR').format(action.count)} مورد سهل‌انگاری با این حساسیت</span><strong>{action.action}</strong></div>:null;})}</div>:<p className="analysis-no-action">برای این خرابی اقدام مدیریتی لازم نیست.</p>}
        <dl className="analysis-detail-facts"><div><dt>ماشین</dt><dd>{reviewPreview.machine_code}</dd></div><div><dt>تاریخ بررسی</dt><dd>{dateFmt.format(new Date(reviewPreview.analysis_date+'T00:00:00Z'))}</dd></div><div><dt>راننده</dt><dd>{driverLabel(reviewPreview)}</dd></div><div><dt>مسئول PM</dt><dd>{people.find(person=>person.id===reviewPreview.responses.pm_id)?.name??'ثبت نشده'}</dd></div><div className="span2"><dt>موضوع خرابی</dt><dd>{reviewPreview.topic||'—'}</dd></div>{reviewPreview.cause&&<div className="span2"><dt>علت</dt><dd>{reviewPreview.cause}</dd></div>}</dl>
        <div className="analysis-review-answers"><b>پاسخ‌های بررسی</b><p>۱. آیا علائم به صورتی بوده است که راننده متوجه آن شود؟ <strong>{reviewPreview.responses.q1==='yes'?'بله':'خیر'}</strong>{reviewPreview.responses.q1==='yes'&&<> · گزارش خرابی را به مسئول ماشین‌آلات ارائه داده است؟ <strong>{reviewPreview.responses.q1b==='yes'?'بله':'خیر'}</strong></>}</p><p>۲. آیا علائم به صورتی بوده است که مسئول PM متوجه آن شود؟ <strong>{reviewPreview.responses.q2==='yes'?'بله':'خیر'}</strong>{reviewPreview.responses.q2==='yes'&&<> · گزارش خرابی را به مسئول ماشین‌آلات ارائه داده است؟ <strong>{reviewPreview.responses.q2b==='yes'?'بله':'خیر'}</strong></>}</p><p>۳. آیا فشار به دستگاه می‌تواند یکی از علت‌های خرابی باشد؟ <strong>{reviewPreview.responses.q3==='yes'?'بله':'خیر'}</strong>{reviewPreview.responses.q3==='yes'&&typeof reviewPreview.responses.q3note==='string'&&reviewPreview.responses.q3note&&<> · {reviewPreview.responses.q3note}</>}</p></div>
        {(reviewPreview.goldratt.ude||reviewPreview.goldratt.root||reviewPreview.goldratt.change)&&<div className="analysis-review-answers"><b>تحلیل علت (روش گلدرات)</b>{reviewPreview.goldratt.ude&&<p>اثر نامطلوب: {reviewPreview.goldratt.ude}</p>}{reviewPreview.goldratt.root&&<p>علت ریشه‌ای: {reviewPreview.goldratt.root}</p>}{reviewPreview.goldratt.change&&<p>راهکار پیشنهادی: {reviewPreview.goldratt.change}</p>}</div>}
        {reviewPreview.note&&<div className="analysis-review-answers"><b>یادداشت</b><p>{reviewPreview.note}</p></div>}
      </div>}</fieldset>
        </div>
        <div className="wz-foot">{analysisStep>0?<button className="btn btn-ghost" type="button" disabled={busy} onClick={()=>setAnalysisStep(step=>step-1)}><Icon name="arrow-right"/>مرحلهٔ قبل</button>:<span/>}
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={()=>{setOpen(false);setEditing(null);}}><Icon name="x"/>انصراف</button>
          {analysisStep<6?<button className="btn btn-primary" type="submit" disabled={busy}>مرحلهٔ بعد<Icon name="arrow-left"/></button>:<button className="btn btn-primary btn-lg" type="submit" disabled={busy}><Icon name="save"/>{editing?'ذخیره تغییرات':'ثبت نهایی تحلیل'}</button>}
        </div>
      </section>
    </form>}
    {!open&&<><div className="analysis-filter-grid report-filters" aria-label="جست‌وجو و فیلتر تحلیل‌ها">
      <label>جستجو<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="موضوع، علت، نام راننده…" /></label>
      <label>ماشین<select value={machine} onChange={e=>setMachine(e.target.value)}><option value="">همهٔ ماشین‌ها</option>{machines.map(item=><option key={item.id} value={item.id}>{item.code}</option>)}</select></label>
      <label>نتیجه<select value={result} onChange={e=>setResult(e.target.value)}><option value="">همهٔ نتیجه‌ها</option>{Object.entries(resultLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>حساسیت<select value={severity} onChange={e=>setSeverity(e.target.value)}><option value="">همهٔ حساسیت‌ها</option>{Object.entries(severityLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>از تاریخ<PersianDateInput value={from} max={to||undefined} onChange={setFrom} /></label>
      <label>تا تاریخ<PersianDateInput value={to} min={from||undefined} onChange={setTo} /></label>
    </div>{!!items.length&&<p>نمایش {new Intl.NumberFormat('fa-IR').format(filtered.length)} از {new Intl.NumberFormat('fa-IR').format(items.length)} تحلیل</p>}
    {!!filtered.length&&<div className="table-wrap"><table className="table analysis-table"><thead><tr><th>تاریخ</th><th>ماشین</th><th>پرونده</th><th>موضوع</th><th>علت</th><th>راننده</th><th>سرپرست</th><th>حساسیت</th><th>نتیجه</th><th>اقدام مدیریتی</th><th>عملیات</th></tr></thead><tbody>
      {filtered.map(item=><tr key={item.id}><td>{dateFmt.format(new Date(item.analysis_date+'T00:00:00Z'))}</td>
        <td>{item.machine_code}</td><td>{item.repair_number??repairs.find(repair=>repair.id===item.repair_id)?.number??'—'}</td><td>{item.topic}</td><td>{item.cause||'—'}</td><td>{driverLabel(item)}</td><td>{people.find(person=>person.id===item.responses.supervisor_id)?.name??'—'}</td><td><AnalysisSeverityBadge severity={item.severity}/></td><td><AnalysisResultBadge item={item}/></td><td>{(['driver','pm'] as const).map(role=>{const action=actionFor(item,role);const name=role==='driver'?driverLabel(item):people.find(person=>person.id===item.responses.pm_id)?.name;return action?<div key={role}>{name|| (role==='driver'?'راننده':'PM')} · {action.action} <small>({new Intl.NumberFormat('fa-IR').format(action.count)} بار)</small></div>:null})}</td><td><button type="button" onClick={()=>setSelected(item)}>جزئیات</button></td></tr>)}
    </tbody></table></div>}
    {!filtered.length&&!busy&&<section className="card flush"><div className="empty"><div className="empty-ic"><Icon name={items.length?'search-x':'clipboard-list'}/></div><h4>{items.length?'تحلیلی با این فیلترها پیدا نشد':'هنوز تحلیلی ثبت نشده'}</h4>{!items.length&&<><p>هر خرابی را با پاسخ به چند سؤال تحلیل کنید؛ نتیجه و اقدام مدیریتی خودکار مشخص می‌شود.</p>{canEdit&&<button type="button" className="btn btn-primary" onClick={()=>{const machine=machines.find(item=>item.active);setEditing(null);setMachineId(machine?.id??'');setDriverId(machine?.driver_id??'');setDriverName('');setSupervisorId(machine?.supervisor_id??'');setPmId(machine?.pm_id??'');setRepairId('');setDriverAware('');setDriverReported('');setPmAware('');setPmReported('');setPressureAware('');setPressureNote('');setFormSeverity('');setAnalysisStep(0);setReviewData(null);setOpen(true);}}>ثبت اولین تحلیل</button>}</>}</div></section>}</>}
    </section>
  </section>;
}
