import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from './api';
import { comparePartSystems, partSystemName, partSystems } from './systems';
import { PersianDateInput } from './persian-date';
import { Icon } from './shell';

const states = { over: 'گذشته از موعد', soon: 'نزدیک موعد', ok: 'در موعد', unknown: 'نیازمند ثبت کارکرد', none: 'بدون سابقه', na: 'بدون دوره' };
const dateFormat = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeZone: 'UTC' });
const fa = new Intl.NumberFormat('fa-IR');
const formatDate = (value: string | null) => value ? dateFormat.format(new Date(value + 'T00:00:00Z')) : '—';
const formatNumber = (value: number | null) => value === null ? '—' : fa.format(value);
const unitLabel = (unit: string) => unit === 'hour' ? 'ساعت' : 'کیلومتر';
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tehran' }).format(new Date());

type Machine = { id: string; code: string; unit: string; model_name?:string|null; reading: number | null; reading_date: string | null };
type DuePart = {
  machine_id: string; id: string; name: string; system: string; action:string; note:string; consequence:string; state: keyof typeof states;
  due_reading: number | null; due_date: string | null; last_date: string | null;
  interval_reading: number; interval_months: number; remaining_reading: number | null; remaining_days: number | null;
};
type Overview = { machines: Machine[]; parts: DuePart[] };
type HistoryItem = { id: string; reading: string | null; recorded_on: string; note: string; unit: string };
type History = { readings: HistoryItem[]; services: (HistoryItem & { part_id:string; name: string; kind: string })[] };

export function Maintenance({ onEditPart, canEditParts }: { onEditPart: (id: string) => void; canEditParts: boolean }) {
  const [overview, setOverview] = useState<Overview>({ machines: [], parts: [] });
  const [selected, setSelected] = useState('');
  const [history, setHistory] = useState<History | null>(null);
  const [historyPartId,setHistoryPartId]=useState<string|null>(null);
  const [confirmDelete,setConfirmDelete]=useState<History['services'][number]|null>(null);
  const [mode, setMode] = useState<'readings' | 'services' | 'history' | 'bulk' | null>(null);
  const [servicePart,setServicePart]=useState('');
  const [servicePartSelectable,setServicePartSelectable]=useState(false);
  const [serviceKind,setServiceKind]=useState<'service'|'replacement'>('service');
  const [partQuery,setPartQuery]=useState('');
  const [systemFilter,setSystemFilter]=useState('');
  const [stateFilter,setStateFilter]=useState('all');
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({});
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const machine = overview.machines.find(item => item.id === selected);
  const parts = overview.parts.filter(part => part.machine_id === selected);
  const selectedServicePart=parts.find(part=>part.id===servicePart);
  const systems=[...new Set(parts.map(part=>part.system||'other'))].sort(comparePartSystems);
  const filteredParts=parts.filter(part=>{
    const matches=`${part.name} ${part.system} ${partSystemName(part.system)} ${part.note} ${part.consequence}`.toLocaleLowerCase('fa').includes(partQuery.trim().toLocaleLowerCase('fa'));
    const intervalFilter=stateFilter!=='interval'||part.interval_reading>0||part.interval_months>0;
    const matchesState=stateFilter==='all'||stateFilter==='interval'||part.state===stateFilter;
    return matches&&intervalFilter&&matchesState&&(!systemFilter||(part.system||'other')===systemFilter);
  });
  const counts={all:parts.length,over:parts.filter(part=>part.state==='over').length,soon:parts.filter(part=>part.state==='soon').length,ok:parts.filter(part=>part.state==='ok').length,unknown:parts.filter(part=>part.state==='unknown').length,none:parts.filter(part=>part.state==='none').length,interval:parts.filter(part=>part.interval_reading>0||part.interval_months>0).length};
  const systemsShown=[...new Set(filteredParts.map(part=>part.system||'other'))].sort(comparePartSystems);
  const intervalText=(part:DuePart)=>[
    part.interval_reading>0?`${fa.format(part.interval_reading)} ${unitLabel(machine?.unit??'km')}`:'',
    part.interval_months>0?`${fa.format(part.interval_months)} ماه`:'',
  ].filter(Boolean).join(' · ')||'طبق بازدید';

  useEffect(() => {
    if (!mode) return;
    document.body.classList.add('has-modal');
    const focusTarget = window.requestAnimationFrame(() => {
      const modals=document.querySelectorAll<HTMLElement>('.maintenance-modal');
      const topModal=modals[modals.length-1];
      const fields=Array.from(topModal?.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea, select')??[]);
      (fields.find(field=>!field.closest('.input-date'))??topModal?.querySelector<HTMLElement>('.modal-head button'))?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('.datepicker, .combo-pop')) {
        event.preventDefault();
        if(confirmDelete)setConfirmDelete(null);else setMode(null);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusTarget);
      document.removeEventListener('keydown', closeOnEscape);
      document.body.classList.remove('has-modal');
    };
  }, [mode,confirmDelete]);

  function exportCsv() {
    const cell=(value:unknown)=>{
      let text=String(value??'');
      if(/^\s*[-=+@]/.test(text))text="'"+text;
      return `"${text.replaceAll('"','""')}"`;
    };
    const rows=[['ماشین','قطعه','سیستم','اقدام','آخرین سرویس','موعد بعدی','کارکرد موعد','باقی‌ماندهٔ کارکرد','باقی‌ماندهٔ روز','وضعیت','تبعات تأخیر'],...filteredParts.map(part=>[
      machine?.code,part.name,partSystemName(part.system),part.action,part.last_date,part.due_date,part.due_reading,
      part.remaining_reading,part.remaining_days,states[part.state],part.consequence,
    ])];
    const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;
    link.download=`نگهداری-${(machine?.code??'ناوگان').replace(/[^\p{L}\p{N}-]+/gu,'-')}.csv`;link.click();URL.revokeObjectURL(url);
  }

  useEffect(() => {
    api<Overview>('/maintenance').then(data => {
      setOverview(data);
      setSelected('');
    }).catch(failure => setError(errorMessage(failure))).finally(() => setPending(false));
  }, []);

  async function showHistory(partId:string|null=null) {
    setPending(true);
    setError('');
    setStatus('');
    try {
      setHistory(await api<History>(`/maintenance/${encodeURIComponent(selected)}/history`));
      setHistoryPartId(partId);
      setMode('history');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function deleteService(item:History['services'][number]) {
    if(!machine)return;
    setPending(true);setError('');setStatus('');
    try{
      await api(`/maintenance/${encodeURIComponent(machine.id)}/services/${encodeURIComponent(item.id)}`,'DELETE');
      setHistory(await api<History>(`/maintenance/${encodeURIComponent(machine.id)}/history`));
      setOverview(await api<Overview>('/maintenance'));
      setConfirmDelete(null);
      setStatus('سابقهٔ سرویس حذف شد.');
    }catch(failure){setError(errorMessage(failure));}finally{setPending(false);}
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!machine || (mode !== 'readings' && mode !== 'services'&&mode!=='bulk')) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if(mode==='bulk'){
      const partIds=Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input[name="part_ids"]:checked')).map(input=>input.value);
      if(!partIds.length){setError('حداقل یک قطعه برای سرویس اولیه انتخاب کنید.');return;}
      setPending(true);setError('');setStatus('');
      try{
        const result=await api<{created:number}>(`/maintenance/${encodeURIComponent(machine.id)}/services/bulk`,'POST',{
          date:fields.date,reading:fields.reading===''?null:Number(fields.reading),note:fields.note,part_ids:partIds,
        });
        setMode(null);setStatus(`${fa.format(result.created)} سابقهٔ سرویس اولیه ذخیره شد.`);setOverview(await api<Overview>('/maintenance'));
      }catch(failure){setError(errorMessage(failure));}finally{setPending(false);}
      return;
    }
    const currentReading = fields.reading === '' ? null : Number(fields.reading);
    setPending(true);
    setError('');
    setStatus('');
    try {
      await api(`/maintenance/${encodeURIComponent(machine.id)}/${mode}`, 'POST', { ...fields, reading: currentReading });
      setMode(null);
      setStatus('سابقه ذخیره شد.');
      setOverview(await api<Overview>('/maintenance'));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  function openForm(form: 'readings' | 'services') {
    setError('');
    setStatus('');
    setServicePart(form==='services'?parts[0]?.id??'':'');
    setServicePartSelectable(form==='services');
    setServiceKind('service');
    setMode(form);
  }

  function selectBulkParts(selection:'all'|'none'|'unrecorded') {
    const list=document.querySelector<HTMLElement>('.maintenance-bulk-list');
    if(!list)return;
    list.querySelectorAll<HTMLInputElement>('input[name="part_ids"]').forEach(input=>{
      const part=parts.find(item=>item.id===input.value);
      input.checked=selection==='all'||selection==='unrecorded'&&!part?.last_date;
    });
  }

  return <section className="page">
    <header className="page-head"><div className="ph-text"><h1>نگهداری پیشگیرانه{machine&&<> · <bdi>{machine.code}</bdi></>}</h1><p>{machine?`${machine.model_name||'مدل ثبت نشده'} · ${fa.format(parts.length)} قطعه در ${fa.format(systems.length)} سیستم · دوره کارکرد: ${machine.unit==='hour'?'ساعتی':'کیلومتر'}`:'ماشین را انتخاب کنید تا همه قطعاتش همراه با دوره تعویض و وضعیت فعلی نمایش داده شود.'}</p></div>{machine&&<div className="ph-actions" dir="ltr"><button className="btn btn-ghost" type="button" disabled={pending} onClick={exportCsv}><Icon name="file-spreadsheet"/>خروجی</button>{parts.some(part=>part.interval_reading>0||part.interval_months>0)&&<button className="btn btn-ghost" type="button" disabled={pending} onClick={()=>{setError('');setStatus('');setMode('bulk');}}><Icon name="list-checks"/>ثبت سرویس اولیه</button>}{canEditParts&&<button className="btn btn-primary" type="button" disabled={pending} onClick={()=>onEditPart('__new__')}><Icon name="plus"/>افزودن قطعه</button>}</div>}</header>
    <section className="maintenance-page">
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {!pending&&!error&&!selected&&<>
      <div className="howto card">
        <div className="howto-step"><span>۱</span><div><b>کارکرد فعلی را ثبت کنید</b><small>کیلومتر یا ساعت کار فعلی ماشین</small></div></div>
        <div className="howto-step"><span>۲</span><div><b>آخرین تعویض هر قطعه را وارد کنید</b><small>یا یک‌جا برای همه با «ثبت سرویس اولیه»</small></div></div>
        <div className="howto-step"><span>۳</span><div><b>سایت خودش موعد را حساب می‌کند</b><small>زرد: نزدیک موعد · قرمز: گذشته از موعد</small></div></div>
      </div>
      {!overview.machines.length&&<p>برای شروع، یک ماشین فعال ثبت کنید.</p>}
      <div className="maint-grid">{overview.machines.map(item=>{
        const statuses=overview.parts.filter(part=>part.machine_id===item.id);
        const over=statuses.filter(part=>part.state==='over').length,soon=statuses.filter(part=>part.state==='soon').length,ok=statuses.filter(part=>part.state==='ok').length,unknown=statuses.filter(part=>part.state==='unknown').length;
        const tracked=over+soon+ok,progress=tracked?Math.round(ok/tracked*100):0;
        const ringColor=over?'var(--crit)':soon?'var(--warn)':'var(--good)';
        return <button type="button" className="maint-pick" key={item.id} onClick={()=>{setSelected(item.id);setMode(null);setError('');setStatus('');}}>
          <span className="mpk-ring" aria-label={tracked?`${fa.format(progress)} درصد قطعات در موعد`:unknown?'برای محاسبهٔ موعد، کارکرد لازم است':'بدون دورهٔ ثبت‌شده'}>
            <svg viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="24" fill="none" stroke="var(--surface-3)" strokeWidth="6"/><circle cx="28" cy="28" r="24" fill="none" stroke={ringColor} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${Math.PI*48*(tracked?progress/100:0)} ${Math.PI*48}`} transform="rotate(-90 28 28)"/></svg>
            <span>{tracked?`${fa.format(progress)}٪`:'—'}</span>
          </span>
          <span className="mpk-main"><b>{item.code}</b><small>{item.model_name||'مدل ثبت نشده'} · {item.reading===null?'کارکرد ثبت نشده':`${formatNumber(item.reading)} ${unitLabel(item.unit)}${item.reading_date?` · ${formatDate(item.reading_date)}`:''}`}</small>
            <span className="mpk-tags">{over>0&&<span className="st st-crit"><Icon name="octagon-alert"/>{fa.format(over)} گذشته</span>}{soon>0&&<span className="st st-warn"><Icon name="triangle-alert"/>{fa.format(soon)} نزدیک</span>}{unknown>0&&<span className="st st-warn"><Icon name="triangle-alert"/>{fa.format(unknown)} نیازمند کارکرد</span>}{!tracked&&!unknown&&<span className="st st-muted"><Icon name="circle-dashed"/>هنوز راه‌اندازی نشده</span>}{tracked>0&&!over&&!soon&&!unknown&&<span className="st st-good"><Icon name="circle-check"/>همه سالم</span>}</span>
          </span><Icon name="chevron-left" className="mpk-go" />
        </button>;
      })}</div>
    </>}
    {machine&&<nav className="maintenance-machine-tabs" aria-label="انتخاب ماشین برای نگهداری" data-selected-machine={selected}><button type="button" onClick={()=>{setSelected('');setMode(null);setStatus('');setError('');}}>همهٔ ماشین‌ها</button>{overview.machines.map(item=><button type="button" key={item.id} aria-current={selected===item.id?'page':undefined} className={selected===item.id?'active':''} onClick={()=>{setSelected(item.id);setMode(null);setStatus('');setError('');}}>{item.code}</button>)}</nav>}
    {machine && <>
      <section className="maint-top"><section className="card odo-hero maintenance-odo-hero"><div className="oh-ic"><Icon name="gauge"/></div><div className="oh-main"><small>کارکرد فعلی {machine.code}</small><b>{machine.reading===null?'ثبت نشده':formatNumber(machine.reading)}</b><span>{machine.reading===null?'برای محاسبه موعد، کارکرد را ثبت کنید':`${unitLabel(machine.unit)}${machine.reading_date?` · ${formatDate(machine.reading_date)}`:''}`}</span></div><button className={`btn ${machine.reading===null?'btn-primary':'btn-ghost'}`} type="button" disabled={pending} onClick={()=>openForm('readings')}><Icon name="pencil"/>{machine.reading===null?'ثبت کارکرد':'به‌روزرسانی'}</button></section>
      <div className="sum-tiles maintenance-state-tiles">
        {([['over','گذشته از موعد',counts.over,'crit','octagon-alert'],['soon','نزدیک موعد',counts.soon,'warn','triangle-alert'],['ok','سالم',counts.ok,'good','circle-check'],['none','ثبت نشده',counts.none,'muted','circle-dashed']] as const).map(([key,label,count,tone,icon])=><button type="button" key={key} className={`sum-tile ${tone} ${stateFilter===key?'on':''}`} aria-pressed={stateFilter===key} onClick={()=>setStateFilter(stateFilter===key?'all':key)}><b>{fa.format(count)}</b><span><Icon name={icon}/>{label}</span></button>)}
      </div></section>
      <div className="toolbar">
        <button disabled={pending || !parts.length} onClick={() => openForm('services')}>ثبت سرویس یا تعویض</button>
        <button disabled={pending} onClick={() => void showHistory()}>سوابق نگهداری</button>
      </div>
      {(mode === 'readings' || mode === 'services'||mode==='bulk') && <div className="modal-wrap in maintenance-modal" onMouseDown={event=>{if(event.target===event.currentTarget)setMode(null);}}>
        <div className="modal-backdrop" aria-hidden="true" onMouseDown={()=>setMode(null)} />
        <section className={`modal ${mode==='bulk'?'modal-lg':'modal-sm'}`} role="dialog" aria-modal="true" aria-labelledby="maintenance-modal-title">
        <header className="modal-head"><span className="modal-ic"><Icon name={mode==='bulk'?'list-checks':mode==='services'?'wrench':'gauge'}/></span><h3 id="maintenance-modal-title">{mode==='bulk'?`ثبت سرویس اولیه · ${machine.code}`:mode==='services'&&selectedServicePart&&!servicePartSelectable?`ثبت ${selectedServicePart.action==='r'?'تعویض':'سرویس'}: ${selectedServicePart.name}`:mode==='services'?`ثبت سرویس یا تعویض · ${machine.code}`:`ثبت کارکرد · ${machine.code}`}</h3><button className="icon-btn" type="button" onClick={()=>setMode(null)} aria-label="بستن"><Icon name="x"/></button></header>
        <form key={mode} id="maintenance-record-form" className="record maintenance-record-form" onSubmit={save}>
        <div className="modal-body">
        {error&&<p role="alert" className="maintenance-modal-error">{error}</p>}
        {mode==='services'&&selectedServicePart&&!servicePartSelectable&&<><div className="modal-ctx"><Icon name="truck"/><b>{machine.code}</b><span>{partSystemName(selectedServicePart.system)}</span></div>{selectedServicePart.last_date&&<div className="muted small maintenance-last-log">آخرین ثبت: {formatDate(selectedServicePart.last_date)} · {unitLabel(machine.unit)}</div>}</>}
        {mode==='bulk'&&<p className="muted maintenance-bulk-intro">برای راه‌اندازی سریع، قطعاتی را که در یک تاریخ و کارکرد مشخص تعویض یا سرویس شده‌اند انتخاب کنید. بعداً هر قطعه را جداگانه هم می‌توانید اصلاح کنید.</p>}
        <div className="fields">
          {mode === 'bulk' ? <>
          <label>تاریخ<PersianDateInput name="date" required defaultValue={today()} /></label>
            <label>کارکرد ({unitLabel(machine.unit)})<input type="number" name="reading" min={0} max={1000000000} step={1} defaultValue={machine.reading??''}/></label>
            <label className="maintenance-bulk-note">یادداشت<textarea name="note" maxLength={4000} defaultValue="سرویس اولیه"/></label>
          </> : mode === 'services' && <>
            {servicePartSelectable?<label>قطعه سرویس<select aria-label="قطعه سرویس" name="part_id" required value={servicePart||parts[0]?.id||''} onChange={event=>{const id=event.target.value;setServicePart(id);setServiceKind(parts.find(part=>part.id===id)?.action==='r'?'replacement':'service');}}>
              {parts.map(part => <option key={part.id} value={part.id}>{part.name}</option>)}
            </select></label>:<input type="hidden" name="part_id" value={servicePart}/>}
            {servicePartSelectable?<label>نوع عملیات<select name="kind" value={serviceKind} onChange={event=>setServiceKind(event.target.value as 'service'|'replacement')}><option value="service">سرویس</option><option value="replacement">تعویض</option></select></label>:<input type="hidden" name="kind" value={selectedServicePart?.action==='r'?'replacement':serviceKind}/>}
          </>}
          {mode!=='bulk'&&<><label>تاریخ ثبت<PersianDateInput name="date" required defaultValue={today()} /></label>
            <label>مقدار کارکرد<input type="number" name="reading" min={0} max={1000000000} step={1}
              required={mode === 'readings'} defaultValue={machine.reading ?? ''} /></label>
            <label>یادداشت نگهداری<textarea name="note" maxLength={4000} /></label></>}
        </div>
        {mode==='bulk'&&<><div className="bulk-tools maintenance-bulk-tools" aria-label="ابزار انتخاب قطعات"><button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={()=>selectBulkParts('all')}>انتخاب همه</button><button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={()=>selectBulkParts('none')}>هیچ‌کدام</button><button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={()=>selectBulkParts('unrecorded')}>فقط ثبت‌نشده‌ها</button></div><div className="bulk-list maintenance-bulk-list">{systems.map(system=>{const systemParts=parts.filter(part=>(part.system||'other')===system&&(part.interval_reading>0||part.interval_months>0));return systemParts.length?<fieldset key={system}><legend>{partSystemName(system)}</legend>{systemParts.map(part=><label className="check" key={part.id}><input type="checkbox" name="part_ids" value={part.id} defaultChecked={!part.last_date}/><span>{part.name}</span></label>)}</fieldset>:null;})}</div></>}
        </div>
        <footer className="modal-foot"><button className="btn btn-ghost" type="button" disabled={pending} onClick={() => setMode(null)}>انصراف</button>
          <button className="btn btn-primary" disabled={pending}>{mode==='bulk'?'ثبت برای موارد انتخاب‌شده':'ثبت'}</button></footer>
        </form>
        </section>
      </div>}
      {mode === 'history' && history && <div className="modal-wrap in maintenance-modal" onMouseDown={event=>{if(event.target===event.currentTarget)setMode(null);}}>
        <div className="modal-backdrop" aria-hidden="true" onMouseDown={()=>setMode(null)} />
        <section className="modal modal-md" role="dialog" aria-modal="true" aria-labelledby="maintenance-history-title">
        <header className="modal-head"><span className="modal-ic"><Icon name="history"/></span><h3 id="maintenance-history-title">{historyPartId?`سوابق: ${parts.find(part=>part.id===historyPartId)?.name??'قطعه'}`:`سوابق نگهداری · ${machine.code}`}</h3><button className="icon-btn" type="button" onClick={()=>setMode(null)} aria-label="بستن"><Icon name="x"/></button></header>
        <div className="modal-body">
        {error&&<p role="alert" className="maintenance-modal-error">{error}</p>}
        <article className="record">
        {!historyPartId&&<><h4>سوابق کارکرد</h4>{!history.readings.length && <p className="muted">سابقه‌ای ثبت نشده است.</p>}
        {!!history.readings.length&&<ul className="hist">{history.readings.map(item => <li key={item.id}><span className="h-dot"/><div><b>{formatDate(item.recorded_on)}</b><small>{fa.format(Number(item.reading))} {unitLabel(item.unit)}{item.note&&` · ${item.note}`}</small></div></li>)}</ul>}</>}
        {!historyPartId&&<h4>سوابق سرویس و تعویض</h4>}
        {!(historyPartId?history.services.filter(item=>item.part_id===historyPartId):history.services).length && <p className="muted">سابقه‌ای ثبت نشده است.</p>}
        {!!(historyPartId?history.services.filter(item=>item.part_id===historyPartId):history.services).length&&<ul className="hist">{(historyPartId?history.services.filter(item=>item.part_id===historyPartId):history.services).map(item => <li className="maintenance-history-service" key={item.id}><span className="h-dot"/><div><b>{item.name} · {item.kind === 'service' ? 'سرویس' : 'تعویض'}</b><small>{formatDate(item.recorded_on)} {item.reading!==null&&`· ${formatNumber(Number(item.reading))} ${unitLabel(item.unit)}`} {item.note}</small></div><button className="icon-btn sm" type="button" disabled={pending} aria-label={`حذف سابقه ${item.name}`} title="حذف" onClick={()=>setConfirmDelete(item)}><Icon name="trash-2"/></button></li>)}</ul>}
        </article>
        </div><footer className="modal-foot"><button className="btn btn-ghost" type="button" onClick={()=>setMode(null)}>بستن</button>{historyPartId&&<button className="btn btn-primary" type="button" disabled={pending} onClick={()=>{const part=parts.find(item=>item.id===historyPartId);setServicePart(historyPartId);setServicePartSelectable(false);setServiceKind(part?.action==='r'?'replacement':'service');setMode('services');setError('');setStatus('');}}><Icon name="plus"/>ثبت سابقهٔ جدید</button>}</footer>
        </section>
      </div>}
      {confirmDelete&&<div className="modal-wrap in maintenance-modal maintenance-confirm-modal" onMouseDown={event=>{if(event.target===event.currentTarget)setConfirmDelete(null);}}>
        <div className="modal-backdrop" aria-hidden="true" onMouseDown={()=>setConfirmDelete(null)}/>
        <section className="modal modal-sm" role="alertdialog" aria-modal="true" aria-labelledby="maintenance-delete-title" aria-describedby="maintenance-delete-message">
          <header className="modal-head"><span className="modal-ic"><Icon name="triangle-alert"/></span><h3 id="maintenance-delete-title">حذف سابقه</h3><button className="icon-btn" type="button" onClick={()=>setConfirmDelete(null)} aria-label="بستن"><Icon name="x"/></button></header>
          <div className="modal-body"><p id="maintenance-delete-message">سابقهٔ سرویس «{confirmDelete.name}» در {formatDate(confirmDelete.recorded_on)} حذف شود؟</p></div>
          <footer className="modal-foot"><button className="btn btn-ghost" type="button" disabled={pending} onClick={()=>setConfirmDelete(null)}>انصراف</button><button className="btn btn-danger" type="button" disabled={pending} onClick={()=>void deleteService(confirmDelete)}>حذف</button></footer>
        </section>
      </div>}
      {!parts.length && <section className="card maintenance-empty"><h3>هنوز قطعه‌ای برای مدل «{machine.model_name||'این ماشین'}» تعریف نشده</h3><p>با «افزودن قطعه» نام قطعه، نوع اقدام (تعویض، بازدید، سرویس، تنظیم، مصرفی) و دوره کیلومتری / ساعتی / ماهانه را وارد کنید.</p>{canEditParts&&<button type="button" onClick={()=>onEditPart('__new__')}>افزودن اولین قطعه</button>}</section>}
      <>
        <div className="toolbar card maintenance-filters"><label>جست‌وجوی قطعه<input value={partQuery} onChange={event=>setPartQuery(event.target.value)} placeholder="جست‌وجوی قطعه… (مثلاً لوله رادیات)" /></label>
          <label>سیستم<select value={systemFilter} onChange={event=>setSystemFilter(event.target.value)}><option value="">همه سیستم‌ها</option>{systems.map(system=><option key={system} value={system}>{partSystemName(system)}</option>)}</select></label>
          <div className="maintenance-state-filter"><div className="seg" role="tablist" aria-label="فیلتر وضعیت قطعات">{([['all','همه',counts.all],['over','گذشته از موعد',counts.over],['soon','نزدیک موعد',counts.soon],['ok','سالم',counts.ok],['none','ثبت‌نشده',counts.none],['interval','فقط قطعات دوره‌ای',counts.interval]] as const).map(([key,label,count])=><button type="button" role="tab" aria-selected={stateFilter===key} className={stateFilter===key?'on':''} key={key} onClick={()=>setStateFilter(key)}>{label}<i>{fa.format(count)}</i></button>)}</div></div>
          {(partQuery||systemFilter||stateFilter!=='all')&&<button type="button" onClick={()=>{setPartQuery('');setSystemFilter('');setStateFilter('all');}}>حذف فیلترها</button>}
        </div>
        {systemsShown.length>0?systemsShown.map(system=>{
          const list=filteredParts.filter(part=>(part.system||'other')===system);const over=list.filter(part=>part.state==='over').length,soon=list.filter(part=>part.state==='soon').length;
          return <section className={`card flush sys-block ${collapsed[system]?'collapsed':''}`} key={system}>
            <button className="sys-head" type="button" aria-expanded={!collapsed[system]} onClick={()=>setCollapsed(value=>({...value,[system]:!value[system]}))}><span className="sys-ic">⚙</span><h3>{partSystemName(system)}</h3><span className="count">{fa.format(list.length)} قطعه</span>{over>0&&<span className="st st-crit">{fa.format(over)}</span>}{soon>0&&<span className="st st-warn">{fa.format(soon)}</span>}<span className="grow"/><span className="chev">⌄</span></button>
            {!collapsed[system]&&<div className="table-wrap"><table className="table maint-table">
              <thead><tr><th>قطعه و توضیح</th><th>اقدام</th><th>دوره</th><th>آخرین سرویس یا تعویض</th><th>موعد بعدی</th><th>باقی‌مانده و پیشرفت</th><th>تبعات تأخیر</th><th>وضعیت</th><th></th></tr></thead>
              <tbody>{list.map(part=>{
                const interval=Number(part.interval_reading)||0,remaining=part.remaining_reading;
                const used=interval>0&&remaining!==null?Math.max(0,Math.min(120,(interval-remaining)*100/interval)):
                  part.interval_months>0&&part.remaining_days!==null?Math.max(0,Math.min(120,(part.interval_months*30.44-part.remaining_days)*100/(part.interval_months*30.44))):null;
                const action:Record<string,string>={r:'تعویض',i:'بازدید',s:'سرویس',a:'تنظیم',c:'مصرفی'};
                return <tr key={part.id} className={`st-row st-row-${part.state}`}>
                  <td className="part-cell"><b>{part.name}</b>{part.note&&<small>{part.note}</small>}</td><td><span className={`act act-${part.action||'i'}`}>{action[part.action]??'بازدید'}</span></td><td>{intervalText(part)}</td>
                  <td>{formatDate(part.last_date)}{part.last_date&&part.remaining_reading!==null&&<small className="maintenance-subline">{formatNumber((part.due_reading??0)-interval)} {unitLabel(machine.unit)}</small>}</td>
                  <td>{part.due_reading!==null?`${formatNumber(part.due_reading)} ${unitLabel(machine.unit)}`:'—'}{part.due_date&&<small className="maintenance-subline">{formatDate(part.due_date)}</small>}</td>
                  <td>{part.state==='none'||part.state==='na'?'—':<div className="maintenance-progress"><span className={part.state==='over'?'maintenance-remaining-over':''}>{[part.remaining_reading!==null?`${formatNumber(Math.abs(part.remaining_reading))} ${unitLabel(machine.unit)} ${part.remaining_reading<0?'گذشته':'مانده'}`:'',part.remaining_days!==null?`${fa.format(Math.abs(part.remaining_days))} روز ${part.remaining_days<0?'گذشته':'مانده'}`:''].filter(Boolean).join(' · ')||'برای محاسبهٔ کیلومتری، کارکرد فعلی را ثبت کنید'}</span>{used!==null&&<progress data-due-state={part.state} value={Math.min(100,used)} max={100} aria-label="درصد مصرف دورهٔ نگهداری"/>}</div>}</td>
                  <td>{part.consequence||'—'}</td><td data-due-state={part.state}>{states[part.state]}</td><td><div className="row-actions"><button type="button" onClick={()=>{setServicePart(part.id);setServicePartSelectable(false);setServiceKind(part.action==='r'?'replacement':'service');setMode('services');setError('');setStatus('');}}>ثبت</button><button type="button" onClick={()=>void showHistory(part.id)}>سوابق</button>{canEditParts&&<button type="button" onClick={()=>onEditPart(part.id)} aria-label={`ویرایش قطعه ${part.name}`}>ویرایش قطعه</button>}</div></td>
                </tr>;
              })}</tbody>
            </table></div>}
          </section>;
          }):parts.length>0?<section className="card"><p>قطعه‌ای با این فیلترها پیدا نشد.</p></section>:null}
      </>
    </>}
    </section>
  </section>;
}

type Catalog = {
  models: { id: string; name: string; machine_codes:string[]; part_count:number; alternative_count:number }[];
  parts: { id: string; model_id: string; name: string; system: string; action:string; note:string; consequence:string; interval_km: number; interval_hours: number; interval_months: number }[];
  alternatives: { id: string; part_id: string; name: string; source: string; note: string; approved: boolean }[];
};

export function Parts({ initialPartId, onInitialPartOpened }: { initialPartId: string | null; onInitialPartOpened: () => void }) {
  const [catalog, setCatalog] = useState<Catalog>({ models: [], parts: [], alternatives: [] });
  const [form, setForm] = useState<{ kind: 'part'; partId?:string } | { kind: 'alternative'; partId: string; alternativeId?:string } | null>(null);
  const [modelFilter,setModelFilter]=useState('all');
  const [partQuery,setPartQuery]=useState('');
  const [systemFilter,setSystemFilter]=useState('');
  const [onlyAlternatives,setOnlyAlternatives]=useState(false);
  const [selectedParts,setSelectedParts]=useState<Set<string>>(new Set());
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const visibleParts=catalog.parts.filter(part=>{
    const alternatives=catalog.alternatives.filter(item=>item.part_id===part.id);
    const matchesModel=modelFilter==='all'||part.model_id===modelFilter;
    const matchesSystem=!systemFilter||(part.system||'other')===systemFilter;
    const matchesSearch=`${part.name} ${part.note} ${part.consequence} ${partSystemName(part.system)} ${alternatives.map(item=>`${item.name} ${item.source} ${item.note}`).join(' ')}`.toLocaleLowerCase('fa').includes(partQuery.trim().toLocaleLowerCase('fa'));
    return matchesModel&&matchesSystem&&matchesSearch&&(!onlyAlternatives||alternatives.length>0);
  });
  const selectedModel=catalog.models.find(model=>model.id===modelFilter);
  const selectedModelParts=catalog.parts.filter(part=>part.model_id===modelFilter);

  useEffect(() => {
    api<Catalog>('/parts').then(value=>{setCatalog(value);setModelFilter(value.models[0]?.id??'all');}).catch(failure => setError(errorMessage(failure))).finally(() => setPending(false));
  }, []);

  useEffect(() => {
    if (!initialPartId || pending) return;
    if(initialPartId==='__new__'){
      setModelFilter(catalog.models[0]?.id??'all');setPartQuery('');setSystemFilter('');setOnlyAlternatives(false);
      setStatus('');setError('');setForm({kind:'part'});onInitialPartOpened();return;
    }
    const part=catalog.parts.find(item=>item.id===initialPartId);
    if (!part) return;
    setModelFilter(part.model_id);setPartQuery('');setSystemFilter('');setOnlyAlternatives(false);
    setStatus('');setError('');setForm({kind:'part',partId:part.id});onInitialPartOpened();
  }, [initialPartId,pending,catalog.parts,onInitialPartOpened]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setPending(true);
    setError('');
    setStatus('');
    try {
      if (form.kind === 'part') {
        await api(form.partId?`/parts/${form.partId}`:'/parts', form.partId?'PATCH':'POST', {
          ...fields, interval_km: Number(fields.interval_km),
          interval_hours: Number(fields.interval_hours), interval_months: Number(fields.interval_months),
        });
      } else {
        await api(form.alternativeId?`/parts/${form.partId}/alternatives/${form.alternativeId}`:`/parts/${form.partId}/alternatives`,form.alternativeId?'PATCH':'POST',{ ...fields, approved: fields.approved === 'on' });
      }
      setForm(null);
      setStatus(form.kind==='alternative'?'جایگزین ذخیره شد.':'اطلاعات قطعه ذخیره شد.');
      setCatalog(await api<Catalog>('/parts'));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function deletePart(part:Catalog['parts'][number]){
    if(!window.confirm(`«${part.name}» از فهرست قطعات حذف شود؟ سوابق سرویس آن در تاریخچهٔ ماشین باقی می‌ماند.`))return;
    setPending(true);setError('');setStatus('');
    try{
      await api(`/parts/${encodeURIComponent(part.id)}`,'DELETE');
      setCatalog(await api<Catalog>('/parts'));
      setStatus('قطعه حذف شد؛ سوابق سرویس آن حفظ شده‌اند.');
    }catch(failure){setError(errorMessage(failure));}finally{setPending(false);}
  }

  async function deleteAlternative(partId:string,alternative:Catalog['alternatives'][number]){
    if(!window.confirm(`جایگزین «${alternative.name}» حذف شود؟`))return;
    setPending(true);setError('');setStatus('');
    try{
      await api(`/parts/${encodeURIComponent(partId)}/alternatives/${encodeURIComponent(alternative.id)}`,'DELETE');
      setCatalog(await api<Catalog>('/parts'));setStatus('جایگزین حذف شد.');
    }catch(failure){setError(errorMessage(failure));}finally{setPending(false);}
  }

  async function deleteSelectedParts(){
    if(modelFilter==='all'||!selectedParts.size)return;
    const selected=visibleParts.filter(part=>selectedParts.has(part.id));
    const model=catalog.models.find(item=>item.id===modelFilter);
    if(!window.confirm(`${fa.format(selected.length)} قطعه از مدل «${model?.name??''}» حذف شود؟ سوابق سرویس با نام قطعات در تاریخچهٔ ماشین می‌مانند.`))return;
    setPending(true);setError('');setStatus('');
    try{
      const result=await api<{deleted:number}>('/parts','DELETE',{model_id:modelFilter,part_ids:selected.map(part=>part.id)});
      setCatalog(await api<Catalog>('/parts'));setSelectedParts(new Set());
      setStatus(`${fa.format(result.deleted)} قطعه حذف شد؛ سوابق سرویس حفظ شدند.`);
    }catch(failure){setError(errorMessage(failure));}finally{setPending(false);}
  }

  function exportPartsCsv(){
    const rows:unknown[][]=[['سیستم','قطعه','اقدام','دورهٔ کیلومتری','دورهٔ ساعتی','دورهٔ ماهانه','توضیح','تبعات',...Array.from({length:Math.max(0,...visibleParts.map(part=>catalog.alternatives.filter(item=>item.part_id===part.id).length))},(_,index)=>[`جایگزین ${index+1}`,`تأمین‌کننده ${index+1}`,`تأیید ${index+1}`]).flat()]];
    for(const part of visibleParts){
      const alternatives=catalog.alternatives.filter(item=>item.part_id===part.id);
      const row:unknown[]=[partSystemName(part.system),part.name,({r:'تعویض',i:'بازدید',s:'سرویس',a:'تنظیم',c:'مصرفی'} as Record<string,string>)[part.action]??'بازدید',part.interval_km,part.interval_hours,part.interval_months,part.note,part.consequence];
      alternatives.forEach(item=>row.push(item.name,item.source,item.approved?'تأییدشده':''));
      while(row.length<rows[0].length)row.push('');
      rows.push(row);
    }
    const cell=(value:unknown)=>{let text=String(value??'');if(/^\s*[-=+@]/.test(text))text="'"+text;return `"${text.replaceAll('"','""')}"`;};
    const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='قطعات-جایگزین.csv';link.click();URL.revokeObjectURL(url);
  }

  return <section className="page">
    <header className="page-head"><div className="ph-text"><h1>قطعات جایگزین</h1><p>{selectedModel?`${selectedModel.name} · ${fa.format(selectedModel.part_count)} قطعه · ${fa.format(selectedModel.alternative_count)} قطعه دارای جایگزین`:'فهرست قطعات هر مدل ماشین، دوره‌های تعویض و جایگزین‌های تأییدشده.'}</p></div><div className="ph-actions">
      <button className="btn btn-ghost" disabled={pending} onClick={exportPartsCsv}><Icon name="file-spreadsheet"/>خروجی</button>
      {!!selectedModel?.part_count&&<button className="btn btn-ghost" disabled={pending||!selectedParts.size} onClick={()=>void deleteSelectedParts()}><Icon name="trash-2"/>حذف قطعه‌ها</button>}
      <button className="btn btn-primary" disabled={pending || !catalog.models.length} onClick={() => { setStatus(''); setForm({ kind: 'part' }); }}><Icon name="plus"/>افزودن قطعه</button>
    </div></header>
    <div className="parts-model-tabs" role="group" aria-label="انتخاب مدل ماشین">
      {catalog.models.map(model=><button type="button" key={model.id} aria-pressed={modelFilter===model.id} className={`parts-model-tab ${modelFilter===model.id?'on':''}`} onClick={()=>{setModelFilter(model.id);setSelectedParts(new Set());setPartQuery('');setSystemFilter('');setOnlyAlternatives(false);setStatus('');setError('');}}>
        <span className="parts-model-icon"><Icon name="truck"/></span><span className="parts-model-main"><b>{model.name}</b><small>{model.machine_codes?.join('، ')||'بدون ماشین'}</small></span><span className="parts-model-count" title="تعداد قطعه‌های دارای جایگزین / همهٔ قطعات"><b>{fa.format(model.alternative_count)}</b><i>/</i>{fa.format(model.part_count)}</span>
      </button>)}
    </div>
    <section className="parts-catalog">
    <div className="toolbar card parts-filters"><label><span className="visually-hidden">جست‌وجوی قطعه یا جایگزین</span><input aria-label="جست‌وجوی قطعه یا جایگزین" value={partQuery} onChange={event=>{setPartQuery(event.target.value);setSelectedParts(new Set());}} placeholder="جستجوی قطعه یا جایگزین…" /></label><label><span className="visually-hidden">سیستم قطعه</span><select aria-label="فیلتر سیستم قطعات" value={systemFilter} onChange={event=>{setSystemFilter(event.target.value);setSelectedParts(new Set());}}><option value="">همه سیستم‌ها</option>{[...new Set(catalog.parts.map(part=>part.system||'other'))].sort(comparePartSystems).map(system=><option key={system} value={system}>{partSystemName(system)}</option>)}</select></label><label className="switch parts-alternatives-switch"><input type="checkbox" aria-label="فقط دارای جایگزین" checked={onlyAlternatives} onChange={event=>{setOnlyAlternatives(event.target.checked);setSelectedParts(new Set());}} /><span className="sw" aria-hidden="true"/><span>فقط دارای جایگزین</span></label></div>
    {selectedModelParts.length>0&&<p>نمایش {fa.format(visibleParts.length)} از {fa.format(selectedModelParts.length)} قطعه</p>}
    {modelFilter!=='all'&&visibleParts.length>0&&<div className="toolbar"><button type="button" disabled={pending} onClick={()=>setSelectedParts(selectedParts.size===visibleParts.length?new Set():new Set(visibleParts.map(part=>part.id)))}>{selectedParts.size===visibleParts.length?'لغو انتخاب همه':'انتخاب همه'}</button><span>{fa.format(selectedParts.size)} قطعه انتخاب شده</span><button type="button" className="btn-danger" disabled={pending||!selectedParts.size} onClick={()=>void deleteSelectedParts()}>حذف قطعات انتخاب‌شده</button></div>}
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {!pending&&!error&&!catalog.models.length&&<section className="card"><div className="empty"><div className="empty-ic"><Icon name="package"/></div><h4>هنوز مدلی تعریف نشده</h4><p>برای افزودن قطعه، ابتدا مدل ماشین را در تنظیمات تعریف کنید.</p></div></section>}
    {!pending&&!error&&selectedModel&&!visibleParts.length&&<section className="card"><div className="empty"><div className="empty-ic"><Icon name={selectedModelParts.length?'search-x':'package'}/></div><h4>{selectedModelParts.length?'قطعه‌ای پیدا نشد':`هنوز قطعه‌ای برای «${selectedModel.name}» تعریف نشده`}</h4><p>{selectedModelParts.length?'فیلترها را تغییر دهید یا پاک کنید.':'قطعه‌ای که اضافه کنید هم در نگهداری پیشگیرانه و هم اینجا دیده می‌شود.'}</p>{!selectedModelParts.length&&<button type="button" className="btn btn-primary" disabled={pending} onClick={()=>{setStatus('');setForm({kind:'part'});}}><Icon name="plus"/>افزودن اولین قطعه</button>}</div></section>}
    {form && <form className="record" key={form.kind === 'part' ? `part-${form.partId??'new'}` : `${form.partId}-${form.alternativeId??'new'}`} onSubmit={save}>
      <div className="fields">
        {form.kind === 'part' ? <>
          <label>مدل قطعه<select aria-label="مدل قطعه" name="model_id" required disabled={Boolean(form.partId)} defaultValue={form.partId?catalog.parts.find(part=>part.id===form.partId)?.model_id:modelFilter==='all'?catalog.models[0]?.id:modelFilter}>
            {catalog.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select></label>
          <label>نام قطعه<input name="name" required maxLength={150} defaultValue={form.partId?catalog.parts.find(part=>part.id===form.partId)?.name:''} /></label>
          <label>سیستم<select name="system" defaultValue={form.partId?catalog.parts.find(part=>part.id===form.partId)?.system??'other':'other'}>{form.partId&&!partSystems.some(([id])=>id===catalog.parts.find(part=>part.id===form.partId)?.system)&&<option value={catalog.parts.find(part=>part.id===form.partId)?.system}>{partSystemName(catalog.parts.find(part=>part.id===form.partId)?.system)}</option>}{partSystems.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
          <label>نوع اقدام<select name="action" defaultValue={form.partId?catalog.parts.find(part=>part.id===form.partId)?.action??'r':'r'}><option value="r">تعویض</option><option value="i">بازدید</option><option value="s">سرویس</option><option value="a">تنظیم</option><option value="c">مصرفی</option></select></label>
          <label>دوره کیلومتری<input type="number" name="interval_km" min={0} max={10000000} defaultValue={form.partId?catalog.parts.find(part=>part.id===form.partId)?.interval_km??0:0} required /></label>
          <label>دوره ساعتی<input type="number" name="interval_hours" min={0} max={10000000} defaultValue={form.partId?catalog.parts.find(part=>part.id===form.partId)?.interval_hours??0:0} required /></label>
          <label>دوره ماهانه<input type="number" name="interval_months" min={0} max={120} defaultValue={form.partId?catalog.parts.find(part=>part.id===form.partId)?.interval_months??0:0} required /></label>
          <label>توضیح قطعه<textarea name="note" maxLength={4000} defaultValue={form.partId?catalog.parts.find(part=>part.id===form.partId)?.note:''}/></label>
          <label>تبعات انجام‌ندادن به‌موقع<textarea name="consequence" maxLength={4000} defaultValue={form.partId?catalog.parts.find(part=>part.id===form.partId)?.consequence:''}/></label>
        </> : <>
          <label>نام قطعه جایگزین<input name="name" required maxLength={150} defaultValue={catalog.alternatives.find(item=>item.id===form.alternativeId)?.name??''} /></label>
          <label>تأمین‌کننده<input name="source" maxLength={150} defaultValue={catalog.alternatives.find(item=>item.id===form.alternativeId)?.source??''} /></label>
          <label>توضیحات جایگزین<textarea name="note" maxLength={4000} defaultValue={catalog.alternatives.find(item=>item.id===form.alternativeId)?.note??''} /></label>
          <label className="check"><input type="checkbox" name="approved" defaultChecked={catalog.alternatives.find(item=>item.id===form.alternativeId)?.approved??false} /> تأیید شده</label>
        </>}
      </div>
      <div className="toolbar"><button disabled={pending}>{form.kind==='alternative'?'ذخیره جایگزین':form.partId?'ذخیره تغییرات قطعه':'ذخیره قطعه'}</button>
        <button type="button" disabled={pending} onClick={() => setForm(null)}>انصراف</button></div>
    </form>}
    {visibleParts.map(part => <article key={part.id} className="record">
      <div className="toolbar">
        {modelFilter!=='all'&&<label className="check"><input type="checkbox" checked={selectedParts.has(part.id)} onChange={event=>setSelectedParts(current=>{const next=new Set(current);if(event.target.checked)next.add(part.id);else next.delete(part.id);return next;})}/><span>انتخاب برای حذف گروهی</span></label>}
        <h3>{part.name}</h3>
        <button disabled={pending} onClick={() => { setStatus(''); setForm({ kind: 'part', partId:part.id }); }}>ویرایش</button>
        <button disabled={pending} onClick={() => void deletePart(part)}>حذف قطعه</button>
        <button disabled={pending} onClick={() => { setStatus(''); setForm({ kind: 'alternative', partId: part.id }); }}>ثبت جایگزین</button>
      </div>
      <p>{catalog.models.find(model => model.id === part.model_id)?.name} · {partSystemName(part.system)} · اقدام {({r:'تعویض',i:'بازدید',s:'سرویس',a:'تنظیم',c:'مصرفی'} as Record<string,string>)[part.action]??'بازدید'} · دوره {fa.format(part.interval_km)} کیلومتر، {fa.format(part.interval_hours)} ساعت، {fa.format(part.interval_months)} ماه</p>
      {part.note&&<p><b>توضیح قطعه: </b>{part.note}</p>}
      {part.consequence&&<p><b>تبعات تأخیر: </b>{part.consequence}</p>}
      <ul>{catalog.alternatives.filter(item => item.part_id === part.id).map(item => <li className="part-alternative-row" key={item.id}>
        <span>{item.name} · {item.approved ? 'تأیید شده' : 'در انتظار تأیید'} {item.source} {item.note}</span><span className="row-actions"><button type="button" disabled={pending} onClick={()=>{setStatus('');setForm({kind:'alternative',partId:part.id,alternativeId:item.id});}}>ویرایش جایگزین</button><button type="button" disabled={pending} onClick={()=>void deleteAlternative(part.id,item)}>حذف جایگزین</button></span>
      </li>)}</ul>
    </article>)}
    </section>
  </section>;
}
