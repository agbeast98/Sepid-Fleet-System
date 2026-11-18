import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, errorMessage } from './api';
import { Icon } from './shell';
import { PersianDateInput } from './persian-date';

type Stage={id:string;label:string;kind:'report'|'step'|'test';mode?:'report'|'step'|'wait'|'done'|'test';loc?:'factory'|'road'|'shop'|'part'|'done';limit:number|null;who?:string;desc?:string};
type Outcome='pass'|'fail'|null;
type Machine={id:string;code:string;plate:string;type:string};
type Repair={id:string;number:string;machine_id:string;machine_code:string;plate:string;type:string;title:string;shop:string;note:string;stage:string;urgency:string;result:Outcome;version:number;workflow:string[];created_at:string;updated_at:string;report_date:string;expected_date:string|null;refer_date:string|null;return_date:string|null;current_stage_since:string|null;current_note:string|null;current_actor:string|null;current_details:Record<string,unknown>|null};
type Event={id:string;stage:string;result:Outcome;note:string;details?:Record<string,string>;voided_at?:string|null;recorded_at:string;actor_name:string};
type Overview={machines:Machine[];repairs:Repair[];stages:Stage[];scope_shop:boolean};
const dateFormat=new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tehran'});
const dateOnlyFormat=new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium',timeZone:'UTC'});
const formatOptionalDate=(value:string)=>{const date=new Date(`${value}T00:00:00Z`);return Number.isNaN(date.valueOf())?value:dateOnlyFormat.format(date);};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const timeNow=()=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tehran',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
const partStatusLabels:Record<string,string>={ordered:'سفارش شد',bought:'خریداری یا هماهنگ شد',shipping:'در راه تعمیرگاه',arrived:'رسید؛ تعمیر در حال انجام'};
const stageLocationIcons:Record<string,string>={factory:'factory',road:'truck',shop:'wrench',part:'package',done:'shield-check'};
const dayCount=new Intl.NumberFormat('fa-IR',{maximumFractionDigits:0});
const urgencyDays:Record<string,number|null>={urgent:0,d13:3,d47:7,none:null};
function calendarDay(value:string){const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);return match?Math.floor(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]))/86400000):NaN;}

export function Status({permissions,allowedStages,quickPickRequest,onOpenMachine,onCreateRepair}:{permissions:Record<string,number>;allowedStages:string[];quickPickRequest:number;onOpenMachine:(id:string)=>void;onCreateRepair:()=>void}){
  const [overview,setOverview]=useState<Overview|null>(null);
  const [selected,setSelected]=useState<Repair|null>(null);
  const [events,setEvents]=useState<Event[]>([]);
  const [stageFilter,setStageFilter]=useState('');
  const [lateOnly,setLateOnly]=useState(false);
  const [machineType,setMachineType]=useState('');
  const [showQuickPick,setShowQuickPick]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  async function refresh(){
    setBusy(true);setError('');
    try{const value=await api<Overview>('/status');setOverview(value);if(selected){const updated=value.repairs.find(item=>item.id===selected.id);if(updated)setSelected(updated);else setSelected(null);}}
    catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}
  }
  useEffect(()=>{void refresh();},[]);
  useEffect(()=>{if(quickPickRequest>0)setShowQuickPick(true);},[quickPickRequest]);
  async function open(repair:Repair){setSelected(repair);setError('');try{setEvents(await api<Event[]>(`/status/${repair.id}/events`));}catch(failure){setError(errorMessage(failure));}}
  async function advance(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!selected)return;
    const currentIndex=selected.workflow.indexOf(selected.stage);const nextId=selected.workflow[currentIndex+1];
    const next=overview?.stages.find(stage=>stage.id===nextId);if(!next)return;
    const form=new FormData(event.currentTarget);setBusy(true);setError('');
    try{
      await api<Repair>(`/repairs/${selected.id}/events`,'POST',{previous:selected.stage,version:selected.version,note:form.get('note'),result:next.kind==='test'?form.get('result'):null,repairer_note:form.get('repairer_note'),delay_reason:form.get('delay_reason'),repeat_current:form.get('repeat_current'),...(next.mode==='wait'?{shop:form.get('shop'),part_name:form.get('part_name'),part_status:form.get('part_status'),part_vendor:form.get('part_vendor'),part_eta:form.get('part_eta'),expected_date:form.get('expected_date')}:{}),event_date:form.get('event_date'),event_time:form.get('event_time')});
      const [value,history]=await Promise.all([api<Overview>('/status'),api<Event[]>(`/status/${selected.id}/events`)]);
      setOverview(value);setEvents(history);setSelected(value.repairs.find(item=>item.id===selected.id)??null);
    }catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}
  }
  const machinesWithRepairs=useMemo(()=>new Set((overview?.repairs??[]).map(item=>item.machine_id)),[overview]);
  const healthy=(overview?.machines??[]).filter(machine=>!machinesWithRepairs.has(machine.id));
  const machineTypeOrder=['ده تن','لودر','تراکتور'];
  const machineTypes=[...new Set((overview?.machines??[]).map(machine=>machine.type.trim()).filter(Boolean))].sort((a,b)=>{
    const ai=machineTypeOrder.indexOf(a),bi=machineTypeOrder.indexOf(b);
    if(ai>=0||bi>=0)return (ai<0?machineTypeOrder.length:ai)-(bi<0?machineTypeOrder.length:bi);
    return a.localeCompare(b,'fa');
  });
  const lastUpdate=(overview?.repairs??[]).map(repair=>repair.updated_at).sort().at(-1);
  function delayInfo(repair:Repair){
    const deadlineLate=!!repair.expected_date&&repair.expected_date<today();
    const stage=overview?.stages.find(item=>item.id===repair.stage);
    const elapsed=repair.current_stage_since?Math.max(0,(Date.now()-Date.parse(repair.current_stage_since))/86400000):null;
    const stageLate=!!stage?.limit&&elapsed!==null&&elapsed>stage.limit;
    const sendLimit=urgencyDays[repair.urgency];
    const sendDays=repair.stage==='report'&&!repair.refer_date&&sendLimit!==null&&sendLimit!==undefined
      ?Math.max(0,calendarDay(today())-(calendarDay(repair.report_date)+sendLimit)):0;
    const sendLate=sendDays>0;
    return {deadlineLate,stageLate,sendLate,sendDays,elapsed,limit:stage?.limit??null,late:deadlineLate||stageLate||sendLate};
  }
  const visible=(overview?.repairs??[]).filter(repair=>{
    const late=delayInfo(repair).late;
    const type=(overview?.machines??[]).find(machine=>machine.id===repair.machine_id)?.type??'';
    return (!stageFilter||repair.stage===stageFilter)&&(!lateOnly||late)&&(!machineType||type===machineType);
  });
  const advanceCandidates=visible.filter(repair=>{const nextId=repair.workflow[repair.workflow.indexOf(repair.stage)+1];return permissions.status>=2&&!!nextId&&allowedStages.includes(nextId);});
  const lateCount=(overview?.repairs??[]).filter(repair=>delayInfo(repair).late).length;
  const lastUpdateLabel=lastUpdate?(()=>{const elapsed=Math.max(0,Date.now()-Date.parse(lastUpdate));const minutes=Math.floor(elapsed/60000);return minutes<1?'همین حالا':minutes<60?`${dayCount.format(minutes)} دقیقه پیش`:minutes<1440?`${dayCount.format(Math.floor(minutes/60))} ساعت پیش`:`${dayCount.format(Math.floor(minutes/1440))} روز پیش`;})():'هنوز وضعیتی ثبت نشده';
  const currentStageEvent=events.slice().reverse().find(item=>item.stage===selected?.stage&&!item.voided_at);
  return <section className="page status-page">
    <header className="page-head"><div className="ph-text"><h1>وضعیت ماشین‌ها</h1><p>{overview?.scope_shop?'ماشین‌هایی که برای تعمیر آمده‌اند؛ هر تغییر را با «ثبت مرحله بعد» وارد کنید':'هر ماشینی که خرابی باز دارد، با مرحله‌ای که الان در آن است'}</p></div>{permissions.status>=2&&allowedStages.length>0&&<div className="ph-actions"><button className="btn btn-primary" type="button" onClick={()=>setShowQuickPick(true)}><Icon name="route"/>ثبت مرحله بعد</button></div>}</header>
    {error&&<p role="alert">{error}</p>}
    {overview&&<>
      {showQuickPick&&<section className="card status-quick-pick"><div className="card-head"><div><h3>انتخاب پرونده برای ثبت مرحلهٔ بعد</h3><small>فقط پرونده‌هایی نمایش داده می‌شوند که مرحلهٔ بعدشان در دسترس شماست.</small></div><button type="button" onClick={()=>setShowQuickPick(false)}>بستن</button></div>{advanceCandidates.length?<ul>{advanceCandidates.map(repair=>{const index=repair.workflow.indexOf(repair.stage);const next=overview.stages.find(stage=>stage.id===repair.workflow[index+1]);return <li key={repair.id}><button type="button" onClick={()=>{setShowQuickPick(false);void open(repair);}}><span><b>{repair.machine_code} · پروندهٔ {repair.number}</b><small>{repair.title}</small></span><span>{overview.stages.find(stage=>stage.id===repair.stage)?.label} ← {next?.label}</span></button></li>;})}</ul>:<p>پرونده‌ای برای ثبت مرحلهٔ بعد در دسترس نیست.</p>}</section>}
      <div className="metrics status-metrics" style={{'--status-columns':Math.min(6,overview.stages.filter(stage=>stage.kind!=='test'&&(!overview.scope_shop||stage.kind==='step')).length+(overview.scope_shop?0:1))} as React.CSSProperties}>
        {overview.stages.filter(stage=>stage.kind!=='test'&&(!overview.scope_shop||stage.kind==='step')).map(stage=>{const location=stage.loc??(stage.kind==='report'?'factory':'shop');return <button className={`status-tile loc-${location}`} key={stage.id} aria-pressed={stageFilter===stage.id} onClick={()=>setStageFilter(stageFilter===stage.id?'':stage.id)}><span><Icon name={stageLocationIcons[location]??'wrench'}/>{stage.label}</span><b>{new Intl.NumberFormat('fa-IR').format(overview.repairs.filter(item=>item.stage===stage.id).length)}</b></button>;})}
        {!overview.scope_shop&&<div className="status-tile healthy-tile loc-done"><span><Icon name="circle-check"/>سالم و در حال کار</span><b>{new Intl.NumberFormat('fa-IR').format(healthy.length)}</b></div>}
      </div>
      <div className="chips-row status-filters"><button type="button" className={`chip${machineType===''?' on':''}`} aria-pressed={machineType===''} onClick={()=>setMachineType('')}>همه ({dayCount.format(overview.repairs.length)})</button>
        {machineTypes.map(type=><button type="button" key={type} className={`chip${machineType===type?' on':''}`} aria-pressed={machineType===type} onClick={()=>setMachineType(machineType===type?'':type)}>{type}</button>)}
        <button type="button" className={`chip${lateOnly?' on crit':''}`} aria-pressed={lateOnly} onClick={()=>setLateOnly(value=>!value)}><Icon name="clock"/>فقط تأخیردارها{lateCount?` (${dayCount.format(lateCount)})`:''}</button>
        <span className="chips-meta"><Icon name="clock"/>{lastUpdateLabel}</span>
      </div>
      {visible.length>0?<div className="status-grid">{visible.map(repair=>{
        const index=repair.workflow.indexOf(repair.stage);const next=overview.stages.find(stage=>stage.id===repair.workflow[index+1]);
        const delay=delayInfo(repair);const late=delay.late;
        const details=repair.current_details??{};
        const partSummary=[typeof details.part_name==='string'?`قطعه یا خدمت: ${details.part_name}`:'',typeof details.part_status==='string'?partStatusLabels[details.part_status]??details.part_status:'',typeof details.part_vendor==='string'?`تأمین: ${details.part_vendor}`:'',typeof details.part_eta==='string'?`تحویل: ${formatOptionalDate(details.part_eta)}`:''].filter(Boolean).join(' · ');
        const currentNote=repair.current_note?.trim()&&repair.current_note!==repair.title?repair.current_note.trim():'';
        return <article className={`status-card${late?' status-late':''}`} key={repair.id}>
          <div className="toolbar"><div><strong>{repair.machine_code}</strong>{repair.plate&&<small> · {repair.plate}</small>}<h3>{repair.title}</h3></div><span className={`status-urgency urgency-${repair.urgency}`}>{({urgent:'فوری',d13:'۱ تا ۳ روز',d47:'۴ تا ۷ روز',none:'ضروری نیست'} as Record<string,string>)[repair.urgency]??repair.urgency}</span>{delay.deadlineLate&&<span className="late-tag">تأخیر از موعد تعمیر</span>}{delay.stageLate&&<span className="late-tag stage-late-tag">بیش از سقف مرحله</span>}{delay.sendLate&&<span className="late-tag stage-late-tag">تأخیر در ارجاع · {dayCount.format(delay.sendDays)} روز</span>}</div>
          <div className="status-stepper">{repair.workflow.map((id,stepIndex)=>{const stage=overview.stages.find(item=>item.id===id);const complete=stepIndex<index;return <span key={id} title={[stage?.desc,stage?.who?`مسئول ثبت: ${stage.who}`:'',stage?.limit?`حد مجاز: ${dayCount.format(stage.limit)} روز`: ''].filter(Boolean).join(' · ')||undefined} className={complete?'step-complete':id===repair.stage?'step-current':'step-pending'}>{complete?'✓':stepIndex+1} {stage?.label??id}{stage?.limit?` · ${dayCount.format(stage.limit)} روز`:''}</span>;})}</div>
          <p>تاریخ اعلام: {dateOnlyFormat.format(new Date(repair.report_date+'T00:00:00Z'))} · مرحلهٔ فعلی: <b>{overview.stages.find(stage=>stage.id===repair.stage)?.label??repair.stage}</b>{next&&<> · بعدی: {next.label}</>}</p>
          {(currentNote||partSummary||repair.current_actor)&&<p className="status-card-latest">{currentNote&&<>آخرین یادداشت: {currentNote}</>}{partSummary&&<>{currentNote?' · ':''}{partSummary}</>}{repair.current_actor&&<> · ثبت‌کننده: {repair.current_actor}</>}</p>}
          {delay.elapsed!==null&&<p className={delay.stageLate?'status-delay-copy':''}>زمان در مرحلهٔ فعلی: {dayCount.format(Math.floor(delay.elapsed))} روز{delay.limit?` از سقف ${dayCount.format(delay.limit)} روز`:''}</p>}
          {repair.shop&&<p>تعمیرگاه: {repair.shop}</p>}
          {repair.expected_date&&<p>موعد پیش‌بینی: {dateOnlyFormat.format(new Date(repair.expected_date+'T00:00:00Z'))}</p>}
          <div className="toolbar"><button type="button" onClick={()=>void open(repair)}>جزئیات و تاریخچه</button>{next&&permissions.status>=2&&allowedStages.includes(next.id)&&<button type="button" className="btn-primary" onClick={()=>void open(repair)}>ثبت مرحلهٔ بعد: {next.label}</button>}</div>
        </article>;
      })}</div>:<section className="card"><div className="empty status-empty"><div className="empty-ic"><Icon name={overview.repairs.length?'search-x':'shield-check'}/></div><h4>{overview.repairs.length?'ماشینی با این فیلترها پیدا نشد':overview.scope_shop?'الان ماشینی در تعمیر نیست':'همهٔ ماشین‌ها سالم و در حال کارند'}</h4>{!overview.repairs.length&&<><p>هر وقت خرابی اعلام شود، ماشین با مرحله‌اش اینجا نشان داده می‌شود.</p>{(permissions.repairs??0)>=2&&<button type="button" className="btn btn-primary" onClick={onCreateRepair}><Icon name="plus"/>اعلام خرابی</button>}</>}</div></section>}
      {!overview.scope_shop&&<section className="card status-healthy"><h3><Icon name="circle-check"/>سالم و در حال کار</h3>{healthy.length?<div>{healthy.map(machine=><span key={machine.id}><i aria-hidden="true"/>{(permissions.machines??0)>=1?<button type="button" onClick={()=>onOpenMachine(machine.id)}><bdi>{machine.code}</bdi></button>:<bdi>{machine.code}</bdi>}</span>)}</div>:<p>همهٔ ماشین‌ها پروندهٔ باز دارند.</p>}</section>}
      <section className="card status-stage-legend"><div className="card-head"><h3><Icon name="route"/>مراحل پیگیری خرابی</h3><span className="muted small">هر مرحله فقط بعد از ثبت مرحله قبل باز می‌شود</span></div><div className="status-stage-legend-grid">{overview.stages.map((stage,index)=><div className={`loc-${stage.loc??(stage.kind==='report'?'factory':stage.kind==='test'?'done':'shop')}`} key={stage.id}><span className="stp-dot">{new Intl.NumberFormat('fa-IR').format(index+1)}</span><span><b>{stage.label}</b><small>{stage.desc}{stage.limit?` · حد مجاز ${new Intl.NumberFormat('fa-IR').format(stage.limit)} روز`:''}</small></span></div>)}</div></section>
    </>}
    {selected&&overview&&<div className="status-detail-backdrop" role="presentation" onClick={event=>{if(event.target===event.currentTarget)setSelected(null);}}><article className="status-detail record" aria-label="جزئیات وضعیت ماشین">
      <div className="toolbar"><div><h3>{selected.machine_code} · پروندهٔ {selected.number}</h3><p>{selected.title}</p></div><button type="button" onClick={()=>setSelected(null)}>بستن</button></div>
      <h4>تاریخچهٔ وضعیت</h4><ol>{events.map(item=><li key={item.id}><b>{overview.stages.find(stage=>stage.id===item.stage)?.label??item.stage}</b>{item.details?.repeat_current&&' · به‌روزرسانی همین مرحله'}{item.voided_at&&' · لغوشده'} · {item.actor_name} · {dateFormat.format(new Date(item.recorded_at))}{item.result&&` · ${item.result==='pass'?'تست قبول':item.result==='fail'?'تست رد':'بسته‌شده پیش از ثبت تست'}`}{item.note&&<p>{item.note}</p>}{item.details?.part_name&&<p>قطعه یا خدمت: {item.details.part_name}{item.details.part_status&&` · ${partStatusLabels[item.details.part_status]??item.details.part_status}`}{item.details.part_vendor&&` · ${item.details.part_vendor}`}{item.details.part_eta&&` · تحویل: ${item.details.part_eta}`}</p>}</li>)}</ol>
      {(()=>{const index=selected.workflow.indexOf(selected.stage);const next=overview.stages.find(stage=>stage.id===selected.workflow[index+1]);if(!next)return null;return permissions.status>=2&&allowedStages.includes(next.id)?<form className="record" onSubmit={advance}>
        <h4>ثبت مرحله: {next.label}</h4>{next.kind==='test'&&<label>نتیجهٔ تست<select name="result" required defaultValue=""><option value="" disabled>انتخاب نتیجه</option><option value="pass">قبول</option><option value="fail">رد</option></select></label>}
        {next.mode==='done'&&<label>نظر تعمیرکار<textarea name="repairer_note" maxLength={4000}/></label>}{next.kind==='test'&&<label>علت تأخیر<textarea name="delay_reason" maxLength={4000}/></label>}
        {next.mode==='wait'&&<><label>تعمیرگاه یا تعمیرکار<input name="shop" maxLength={150} defaultValue={selected.shop}/></label><label>قطعه یا خدمت مورد انتظار<input name="part_name" maxLength={200}/></label><label>وضعیت تأمین<select name="part_status" defaultValue="ordered"><option value="ordered">سفارش یا درخواست داده شد</option><option value="bought">خریداری یا هماهنگ شد</option><option value="shipping">در راه تعمیرگاه</option><option value="arrived">رسید؛ تعمیر در حال انجام</option></select></label><label>فروشنده یا محل تأمین<input name="part_vendor" maxLength={200}/></label><label>تحویل تقریبی قطعه یا خدمت<PersianDateInput name="part_eta"/></label><label>موعد پیش‌بینی پایان تعمیر<PersianDateInput name="expected_date" defaultValue={selected.expected_date??''}/></label></>}
        <div className="fields"><label>تاریخ ثبت مرحله<PersianDateInput name="event_date" defaultValue={today()}/></label><label>ساعت ثبت مرحله<input name="event_time" type="time" defaultValue={timeNow()}/></label></div>
        <label>یادداشت این مرحله<textarea name="note" maxLength={4000}/></label><button disabled={busy}>ذخیرهٔ مرحله</button>
      </form>:<p>برای ثبت مرحلهٔ بعد دسترسی مجاز ندارید.</p>;})()}
      {overview.stages.find(stage=>stage.id===selected.stage)?.mode==='wait'&&permissions.status>=2&&allowedStages.includes(selected.stage)&&<form className="record" key={`${selected.id}-${selected.version}-${events.at(-1)?.id??'repeat'}-${events.at(-1)?.voided_at??'active'}`} onSubmit={advance}><h4>به‌روزرسانی همین مرحله</h4><input type="hidden" name="repeat_current" value="true"/><label>تعمیرگاه یا تعمیرکار<input name="shop" maxLength={150} defaultValue={selected.shop}/></label><label>قطعه یا خدمت مورد انتظار<input name="part_name" maxLength={200} defaultValue={currentStageEvent?.details?.part_name??''}/></label><label>وضعیت تأمین<select name="part_status" defaultValue={currentStageEvent?.details?.part_status??'ordered'}><option value="ordered">سفارش یا درخواست داده شد</option><option value="bought">خریداری یا هماهنگ شد</option><option value="shipping">در راه تعمیرگاه</option><option value="arrived">رسید؛ تعمیر در حال انجام</option></select></label><label>فروشنده یا محل تأمین<input name="part_vendor" maxLength={200} defaultValue={currentStageEvent?.details?.part_vendor??''}/></label><label>تحویل تقریبی قطعه یا خدمت<PersianDateInput name="part_eta" defaultValue={currentStageEvent?.details?.part_eta??''}/></label><label>موعد پیش‌بینی پایان تعمیر<PersianDateInput name="expected_date" defaultValue={selected.expected_date??''}/></label><label>یادداشت این مرحله<textarea name="note" maxLength={4000}/></label><div className="fields"><label>تاریخ ثبت مرحله<PersianDateInput name="event_date" defaultValue={today()}/></label><label>ساعت ثبت مرحله<input name="event_time" type="time" defaultValue={timeNow()}/></label></div><button disabled={busy}>ثبت به‌روزرسانی همین مرحله</button></form>}
    </article></div>}
  </section>;
}
