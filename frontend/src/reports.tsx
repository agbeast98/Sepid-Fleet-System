import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from './api';
import { PersianDateInput } from './persian-date';
import { Icon } from './shell';

type RepairReport = { id:string; number: string; created_at: string; report_date: string; refer_date: string | null; expected_date: string | null; repair_completed_date:string|null; return_date: string | null; test_completed_date:string|null; test_note:string|null; diagnoser: string; repairer_note: string; delay_reason: string; note:string; machine_code: string; title: string; urgency: string; shop: string; stage: string; result: string | null; updated_at: string; current_stage_since: string | null };
type StageDefinition = { id: string; label: string; limit: number | null };
const stageLabels: Record<string, string> = { report: 'اعلام خرابی', wait: 'انتظار قطعه یا خدمات', done: 'پایان تعمیر', test: 'تست سلامت' };
const urgencyLabels: Record<string, string> = { urgent: 'فوری', d13: '۱ تا ۳ روز', d47: '۴ تا ۷ روز', none: 'ضروری نیست' };
const dateFormat = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeZone: 'Asia/Tehran' });
const isoDate = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Tehran', calendar: 'gregory' });
function tehranDate(value: string): string {
  const parts = Object.fromEntries(isoDate.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^\s*[-=+@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
function htmlEscape(value:unknown):string{return String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]??character));}

export function Reports({onOpenRepair,initialArchive='all'}:{onOpenRepair:(id:string)=>void;initialArchive?:'all'|'open'|'closed'}) {
  const [rows, setRows] = useState<RepairReport[]>([]);
  const [stages, setStages] = useState<StageDefinition[]>([]);
  const [query, setQuery] = useState('');
  const [archive, setArchive] = useState<'all' | 'open' | 'closed'>(initialArchive);
  const [archiveResult, setArchiveResult] = useState<'pass' | 'fail' | 'old' | ''>('');
  const [machine, setMachine] = useState('');
  const [stage, setStage] = useState('');
  const [urgency, setUrgency] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  async function refresh() {
    setBusy(true); setError('');
    try { const [reports, configuredStages] = await Promise.all([api<RepairReport[]>('/reports/repairs'), api<StageDefinition[]>('/repairs/stages')]); setRows(reports); setStages(configuredStages); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const stageName = (id: string) => stages.find(item => item.id === id)?.label ?? stageLabels[id] ?? id;
  const days = (value: string) => { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); return match ? Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000) : NaN; };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  function delayDays(row: RepairReport) {
    const candidates: number[] = [];
    if (row.expected_date && (row.return_date || row.refer_date)) {
      const end = row.return_date ? days(row.return_date) : days(today);
      candidates.push(end - days(row.expected_date));
    }
    const sendLimit: Record<string, number | null> = { urgent: 0, d13: 3, d47: 7, none: null };
    const limit = sendLimit[row.urgency];
    if (row.stage === 'report' && !row.refer_date && limit !== null && limit !== undefined) candidates.push(days(today) - (days(row.report_date) + limit));
    const stage = stages.find(item => item.id === row.stage);
    if (stage?.limit && row.current_stage_since) candidates.push(Math.floor((Date.now() - Date.parse(row.current_stage_since)) / 86400000) - stage.limit);
    return Math.max(0, ...candidates);
  }
  const filtered = useMemo(() => rows.filter(row => {
    const match = `${row.number} ${row.machine_code} ${row.title} ${row.shop} ${row.diagnoser} ${row.repairer_note} ${row.delay_reason} ${row.test_note??''} ${row.note}`.toLocaleLowerCase('fa').includes(query.trim().toLocaleLowerCase('fa'));
    const date = row.report_date;
    return match && (archive === 'all' || (archive === 'closed') === (row.result !== null))
      && (!machine || row.machine_code === machine)
      && (!stage || row.stage === stage)
      && (!urgency || row.urgency === urgency)
      && (!from || date >= from) && (!to || date <= to);
  }), [rows, query, archive, machine, stage, urgency, from, to]);
  const stageTotals = useMemo(() => stages.map(item => ({...item,count:rows.filter(row=>{
    const match = `${row.number} ${row.machine_code} ${row.title} ${row.shop} ${row.diagnoser} ${row.repairer_note} ${row.delay_reason} ${row.test_note??''} ${row.note}`.toLocaleLowerCase('fa').includes(query.trim().toLocaleLowerCase('fa'));
    const date=row.report_date;
    return match&&(archive==='all'||(archive==='closed')===(row.result!==null))&&(!machine||row.machine_code===machine)&&(!urgency||row.urgency===urgency)&&(!from||date>=from)&&(!to||date<=to)&&row.stage===item.id;
  }).length})),[rows,stages,query,archive,machine,urgency,from,to]);
  const lateCount = filtered.reduce((count, row) => count + (delayDays(row) > 0 ? 1 : 0), 0);
  const needsReasonCount = filtered.reduce((count, row) => count + (delayDays(row) > 0 && !row.delay_reason.trim() ? 1 : 0), 0);
  const isArchivePage = initialArchive === 'closed';
  const archivedRows = useMemo(() => rows.filter(row => {
    const testDate = row.test_completed_date || row.return_date || '';
    const search = `${row.machine_code} ${row.title} ${row.shop} ${row.diagnoser} ${row.repairer_note} ${row.note} ${row.test_note ?? ''}`.toLocaleLowerCase('fa');
    return row.result !== null
      && (!archiveResult || row.result === archiveResult)
      && (!machine || row.machine_code === machine)
      && search.includes(query.trim().toLocaleLowerCase('fa'))
      && (!from || (testDate && testDate >= from))
      && (!to || (testDate && testDate <= to));
  }).sort((a,b) => (b.test_completed_date || b.return_date || '').localeCompare(a.test_completed_date || a.return_date || '') || b.updated_at.localeCompare(a.updated_at)), [rows, archiveResult, machine, query, from, to]);
  const archivedOnly = rows.filter(row => row.result !== null);
  const archivedPass = archivedOnly.filter(row => row.result === 'pass').length;
  const archivedFail = archivedOnly.filter(row => row.result === 'fail').length;
  const archivedOld = archivedOnly.filter(row => row.result === 'old').length;

  function exportCsv() {
    const rowsToExport = isArchivePage ? archivedRows : filtered;
    const headings = ['شماره پرونده','تاریخ اعلام','کد ماشین','شرح خرابی','فوریت','مسئول تشخیص','تعمیرگاه یا تعمیرکار','تاریخ ارجاع','پیش‌بینی پایان','تاریخ پایان تعمیر','تاریخ تست سلامت','نتیجه تست سلامت','شرح تست سلامت','نظر تعمیرکار','علت تأخیر','توضیحات','روز تأخیر جاری','مرحلهٔ جاری','وضعیت پرونده'];
    const formatOptional = (value: string | null) => value ? dateFormat.format(new Date(value+'T00:00:00Z')) : '';
    const values = rowsToExport.map(row => [row.number,dateFormat.format(new Date(row.report_date+'T00:00:00Z')),row.machine_code,row.title,urgencyLabels[row.urgency] ?? row.urgency,row.diagnoser,row.shop,formatOptional(row.refer_date),formatOptional(row.expected_date),formatOptional(row.repair_completed_date),formatOptional(row.test_completed_date),row.result === 'pass' ? 'قبول' : row.result === 'fail' ? 'رد' : row.result === 'old' ? 'قبل از راه‌اندازی تست' : '',row.test_note??'',row.repairer_note,row.delay_reason,row.note,String(delayDays(row)),stageName(row.stage),row.result === 'pass' ? 'بایگانی‌شده · تست قبول' : row.result === 'fail' ? 'بایگانی‌شده · تست رد' : row.result === 'old' ? 'بایگانی‌شده · پیش از تست سلامت' : 'در جریان']);
    const content = '\uFEFF' + [headings, ...values].map(line => line.map(csvCell).join(',')).join('\r\n');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    link.download = isArchivePage ? 'بایگانی-تعمیرات.csv' : 'گزارش-تعمیرات.csv'; link.click(); URL.revokeObjectURL(link.href);
  }

  function printReport(){
    const rowsToPrint = isArchivePage ? archivedRows : filtered;
    const popup=window.open('','_blank');
    if(!popup){setError('پنجرهٔ چاپ باز نشد؛ اجازهٔ بازشدن پنجره را در مرورگر فعال کنید.');return;}
    const visibleFilters=[query&&`جست‌وجو: ${query}`,isArchivePage?(archiveResult==='pass'?'تست سلامت قبول':archiveResult==='fail'?'تست سلامت رد':'بایگانی تعمیرات'):(archive==='open'?'پرونده‌های در جریان':archive==='closed'?'پرونده‌های بایگانی‌شده':'همهٔ پرونده‌ها'),machine&&`ماشین: ${machine}`,!isArchivePage&&stage&&`مرحله: ${stageName(stage)}`,!isArchivePage&&urgency&&`فوریت: ${urgencyLabels[urgency]??urgency}`,from&&`از ${dateFormat.format(new Date(from+'T00:00:00Z'))}`,to&&`تا ${dateFormat.format(new Date(to+'T00:00:00Z'))}`].filter(Boolean).join(' · ');
    const openCount=rowsToPrint.filter(row=>row.result===null).length;
    const passed=rowsToPrint.filter(row=>row.result==='pass').length;
    const failed=rowsToPrint.filter(row=>row.result==='fail').length;
    const oldCount=rowsToPrint.filter(row=>row.result==='old').length;
    const printedLateCount=rowsToPrint.filter(row=>delayDays(row)>0).length;
    const printedNeedsReason=rowsToPrint.filter(row=>delayDays(row)>0&&!row.delay_reason.trim()).length;
    const rowsHtml=rowsToPrint.map((row,index)=>`<tr><td>${new Intl.NumberFormat('fa-IR').format(Number(row.number)||index+1)}</td><td>${htmlEscape(row.machine_code)}</td><td>${htmlEscape(dateFormat.format(new Date(row.report_date+'T00:00:00Z')))}</td><td>${htmlEscape(row.title)}${row.repairer_note?`<small>نظر تعمیرکار: ${htmlEscape(row.repairer_note)}</small>`:''}${row.note?`<small>توضیحات: ${htmlEscape(row.note)}</small>`:''}</td><td>${htmlEscape(urgencyLabels[row.urgency]??row.urgency)}</td><td>${htmlEscape(row.diagnoser||'—')}</td><td>${htmlEscape(row.shop||'—')}</td><td>${row.refer_date?htmlEscape(dateFormat.format(new Date(row.refer_date+'T00:00:00Z'))):'—'}</td><td>${row.expected_date?htmlEscape(dateFormat.format(new Date(row.expected_date+'T00:00:00Z'))):'—'}</td><td>${row.repair_completed_date?htmlEscape(dateFormat.format(new Date(row.repair_completed_date+'T00:00:00Z'))):'—'}</td><td>${row.test_completed_date?htmlEscape(dateFormat.format(new Date(row.test_completed_date+'T00:00:00Z'))):'—'}</td><td>${delayDays(row)?`${new Intl.NumberFormat('fa-IR').format(delayDays(row))} روز`: '—'}</td><td>${htmlEscape(row.delay_reason||'—')}</td><td>${htmlEscape(row.result==='old'?'بسته‌شده پیش از ثبت تست':row.result==='pass'?'تست سلامت قبول':row.result==='fail'?'تست سلامت رد':stageName(row.stage))}${row.test_note?`<small>شرح تست: ${htmlEscape(row.test_note)}</small>`:''}</td></tr>`).join('');
    popup.document.open();
    popup.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>${isArchivePage?'بایگانی تعمیرات':'گزارش خرابی‌ها و تعمیرات'}</title><style>
      @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;color:#172126;margin:0;font-size:10px}header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #174e5a;padding:0 0 10px;margin-bottom:12px}h1{font-size:18px;margin:0 0 5px;color:#174e5a}.sub{color:#59656a;font-size:9px}.meta{text-align:left;color:#59656a}.summary{display:flex;gap:8px;margin:10px 0}.summary div{flex:1;padding:8px;border:1px solid #d7dfe1;border-top:3px solid #174e5a;border-radius:5px}.summary b{display:block;font-size:17px;margin-top:4px}.summary .late{border-top-color:#be3636}.summary .pass{border-top-color:#168351}.summary .fail{border-top-color:#be3636}table{width:100%;border-collapse:collapse;font-size:8px}th,td{padding:5px 4px;border:1px solid #ccd4d6;vertical-align:top;text-align:right}th{background:#edf2f3;color:#173f47;font-weight:700}tbody tr:nth-child(even){background:#f8faf9}small{display:block;color:#59656a;margin-top:3px;max-width:150px;white-space:pre-wrap}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:30px;margin-top:30px;text-align:center}.signatures div{border-top:1px solid #68777b;padding-top:7px}.footer{margin-top:12px;text-align:left;color:#7b8588;font-size:8px}@media print{button{display:none}}
      </style></head><body><header><div><h1>${isArchivePage?'بایگانی تعمیرات':'گزارش خرابی‌ها و تعمیرات'}</h1><div class="sub">${htmlEscape(visibleFilters)}</div></div><div class="meta">تاریخ تهیه: ${htmlEscape(dateFormat.format(new Date()))}<br>تعداد: ${new Intl.NumberFormat('fa-IR').format(rowsToPrint.length)} پرونده</div></header><section class="summary"><div>در جریان<b>${new Intl.NumberFormat('fa-IR').format(openCount)}</b></div><div>تست قبول<b>${new Intl.NumberFormat('fa-IR').format(passed)}</b></div><div class="fail">تست رد<b>${new Intl.NumberFormat('fa-IR').format(failed)}</b></div><div>قبل از راه‌اندازی تست<b>${new Intl.NumberFormat('fa-IR').format(oldCount)}</b></div><div class="late">دارای تأخیر<b>${new Intl.NumberFormat('fa-IR').format(printedLateCount)}</b></div><div class="late">بدون علت تأخیر<b>${new Intl.NumberFormat('fa-IR').format(printedNeedsReason)}</b></div></section><table><thead><tr><th>شماره</th><th>ماشین</th><th>اعلام</th><th>شرح خرابی / نظر تعمیرکار</th><th>فوریت</th><th>مسئول تشخیص</th><th>تعمیرگاه</th><th>ارجاع</th><th>پیش‌بینی</th><th>پایان تعمیر</th><th>تاریخ تست</th><th>تأخیر</th><th>علت تأخیر</th><th>وضعیت / شرح تست</th></tr></thead><tbody>${rowsHtml||'<tr><td colspan="14">پرونده‌ای برای نمایش وجود ندارد.</td></tr>'}</tbody></table><section class="signatures"><div>تهیه‌کننده · مسئول ماشین‌آلات</div><div>سرپرست</div><div>مدیریت</div></section><div class="footer">سامانه ناوگان سپید · گزارش بر اساس پرونده‌های قابل‌دسترسی</div><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`);
    popup.document.close();
  }

  if (isArchivePage) return <>
    <header className="page-head"><div className="ph-text"><h1>بایگانی تعمیرات</h1><p>پرونده خرابی‌هایی که تست سلامتشان در کارخانه ثبت شده است؛ هیچ پرونده‌ای پاک نمی‌شود</p></div><div className="ph-actions"><button className="btn btn-ghost" disabled={busy || !archivedRows.length} onClick={exportCsv}><Icon name="file-spreadsheet"/>خروجی اکسل</button><button className="btn btn-ghost" disabled={busy || !archivedRows.length} onClick={printReport}><Icon name="printer"/>چاپ گزارش</button></div></header>
    <div className="sum-tiles archive-summary">
      <button className={`sum-tile muted ${!archiveResult ? 'on' : ''}`} onClick={() => setArchiveResult('')}><b>{new Intl.NumberFormat('fa-IR').format(archivedOnly.length)}</b><span><Icon name="archive"/>همه پرونده‌های بایگانی</span></button>
      <button className={`sum-tile good ${archiveResult === 'pass' ? 'on' : ''}`} onClick={() => setArchiveResult(archiveResult === 'pass' ? '' : 'pass')}><b>{new Intl.NumberFormat('fa-IR').format(archivedPass)}</b><span><Icon name="circle-check"/>تست سلامت قبول</span></button>
      <button className={`sum-tile crit ${archiveResult === 'fail' ? 'on' : ''}`} onClick={() => setArchiveResult(archiveResult === 'fail' ? '' : 'fail')}><b>{new Intl.NumberFormat('fa-IR').format(archivedFail)}</b><span><Icon name="circle-x"/>تست سلامت رد</span></button>
      <button className={`sum-tile muted ${archiveResult === 'old' ? 'on' : ''}`} onClick={() => setArchiveResult(archiveResult === 'old' ? '' : 'old')}><b>{new Intl.NumberFormat('fa-IR').format(archivedOld)}</b><span><Icon name="history"/>قبل از راه‌اندازی تست</span></button>
    </div>
    {[...new Set(archivedOnly.map(row => row.machine_code))].length > 0 && <div className="chips-row"><button className={`chip ${!machine ? 'on' : ''}`} onClick={() => setMachine('')}>همه ماشین‌ها</button>{[...new Set(archivedOnly.map(row => row.machine_code))].sort((a,b)=>a.localeCompare(b,'fa')).map(code=><button key={code} className={`chip ${machine===code?'on':''}`} onClick={()=>setMachine(machine===code?'':code)}><bdi>{code}</bdi> ({new Intl.NumberFormat('fa-IR').format(archivedOnly.filter(row=>row.machine_code===code).length)})</button>)}</div>}
    <div className="fields report-filters archive-filters">
      <label>جستجو<span className="input-ic"><Icon name="search"/><input className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="نوع خرابی، تعمیرگاه، شرح تست…" /></span></label>
      <label>از تاریخ تست<PersianDateInput value={from} max={to || undefined} onChange={setFrom} /></label>
      <label>تا تاریخ<PersianDateInput value={to} min={from || undefined} onChange={setTo} /></label>
    </div>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">در حال دریافت بایگانی…</p>}
    {!busy && !error && <section className="card flush archive-table">
      {archivedRows.length ? <><div className="table-wrap"><table><thead><tr><th>شماره</th><th>ماشین</th><th>نوع خرابی</th><th>اعلام</th><th>ارسال برای تعمیر</th><th>پایان تعمیر</th><th>تست سلامت</th><th>نتیجه</th><th>مدت توقف</th></tr></thead><tbody>{archivedRows.map((row,index)=>{const delay=delayDays(row);return <tr key={row.id}><td><button className="link" onClick={()=>onOpenRepair(row.id)}>{new Intl.NumberFormat('fa-IR').format(Number(row.number)||index+1)}</button></td><td><b>{row.machine_code||'—'}</b></td><td>{row.title||'—'}{row.repairer_note&&<small>تعمیرکار: {row.repairer_note}</small>}</td><td>{dateFormat.format(new Date(row.report_date+'T00:00:00Z'))}</td><td>{row.refer_date?dateFormat.format(new Date(row.refer_date+'T00:00:00Z')):'—'}</td><td>{row.repair_completed_date?dateFormat.format(new Date(row.repair_completed_date+'T00:00:00Z')):'—'}</td><td>{row.test_completed_date?dateFormat.format(new Date(row.test_completed_date+'T00:00:00Z')):'—'}</td><td>{row.result==='old'?'پیش از راه‌اندازی تست':row.result==='pass'?'تست سلامت قبول':'تست سلامت رد'}{row.test_note&&<small>{row.test_note}</small>}</td><td>{delay?`${new Intl.NumberFormat('fa-IR').format(delay)} روز`:'—'}</td></tr>})}</tbody></table></div><div className="table-foot">{new Intl.NumberFormat('fa-IR').format(archivedRows.length)} پرونده از {new Intl.NumberFormat('fa-IR').format(archivedOnly.length)}</div></> : archivedOnly.length ? <div className="empty"><span className="empty-ic"><Icon name="search-x"/></span><h4>پرونده‌ای با این فیلترها پیدا نشد</h4></div> : <div className="empty"><span className="empty-ic"><Icon name="archive"/></span><h4>بایگانی هنوز خالی است</h4><p>هر خرابی بعد از ثبت «تست سلامت» در کارخانه، اینجا بایگانی می‌شود.</p></div>}
    </section>}
  </>;

  return <>
    <header className="page-head"><div className="ph-text"><h1>گزارش خرابی‌ها و تعمیرات</h1><p>پرونده‌های قابل‌دسترسی را بر اساس ماشین، وضعیت، مرحله و بازهٔ زمانی بررسی کنید.</p></div><div className="ph-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => void refresh()}>تازه‌سازی</button><button className="btn btn-ghost" disabled={!filtered.length} onClick={exportCsv}>دریافت فایل CSV</button><button className="btn btn-ghost" disabled={!filtered.length} onClick={printReport}>چاپ گزارش</button></div></header>
    <div className="fields report-filters">
      <label>جست‌وجو در شماره، ماشین یا شرح<input value={query} onChange={e => setQuery(e.target.value)} placeholder="مثلاً کد ماشین یا شرح خرابی" /></label>
      <label>وضعیت پرونده<select value={archive} onChange={e => setArchive(e.target.value as typeof archive)}><option value="all">همهٔ پرونده‌ها</option><option value="open">در جریان</option><option value="closed">بایگانی‌شده (قبول یا رد)</option></select></label>
      <label>ماشین<select value={machine} onChange={e => setMachine(e.target.value)}><option value="">همهٔ ماشین‌ها</option>{[...new Set(rows.map(row => row.machine_code))].sort((a,b)=>a.localeCompare(b,'fa')).map(code=><option key={code}>{code}</option>)}</select></label>
      <label>مرحله<select value={stage} onChange={e => setStage(e.target.value)}><option value="">همهٔ مرحله‌ها</option>{stages.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>فوریت<select value={urgency} onChange={e => setUrgency(e.target.value)}><option value="">همهٔ فوریت‌ها</option>{Object.entries(urgencyLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>از تاریخ<PersianDateInput value={from} max={to || undefined} onChange={setFrom} /></label>
      <label>تا تاریخ<PersianDateInput value={to} min={from || undefined} onChange={setTo} /></label>
      <button type="button" onClick={() => { setQuery(''); setArchive('all'); setMachine(''); setStage(''); setUrgency(''); setFrom(''); setTo(''); }}>پاک‌کردن فیلترها</button>
    </div>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">در حال دریافت گزارش…</p>}
    {!busy && !error && <div className="metrics report-metrics"><div><span>نتایج فیلترشده</span><b>{new Intl.NumberFormat('fa-IR').format(filtered.length)}</b></div><div><span>پرونده‌های در جریان</span><b>{new Intl.NumberFormat('fa-IR').format(filtered.filter(row=>row.result===null).length)}</b></div><div className={lateCount?'report-metric-late':''}><span>پرونده‌های تأخیردار</span><b>{new Intl.NumberFormat('fa-IR').format(lateCount)}</b></div><div className={needsReasonCount?'report-metric-late':''}><span>نیازمند ثبت علت تأخیر</span><b>{new Intl.NumberFormat('fa-IR').format(needsReasonCount)}</b></div></div>}
    {!busy&&!error&&stageTotals.some(item=>item.count>0)&&<div className="report-stage-summary" aria-label="شمار پرونده‌ها بر اساس مرحله"><span>تفکیک بر اساس مرحله</span>{stageTotals.filter(item=>item.count>0).map(item=><button type="button" key={item.id} aria-pressed={stage===item.id} className={stage===item.id?'active':''} onClick={()=>setStage(current=>current===item.id?'':item.id)}>{item.label}<b>{new Intl.NumberFormat('fa-IR').format(item.count)}</b></button>)}</div>}
    {!!filtered.length && <section className="card flush"><div className="table-wrap"><table><thead><tr><th>شماره</th><th>تاریخ اعلام</th><th>ماشین</th><th>شرح خرابی</th><th>مسئول تشخیص</th><th>فوریت</th><th>تعمیرگاه</th><th>تاریخ ارجاع</th><th>پیش‌بینی پایان</th><th>پایان تعمیر</th><th>تاریخ تست</th><th>تأخیر</th><th>وضعیت</th></tr></thead>
      <tbody>{filtered.map(row => { const delay = delayDays(row); return <tr key={row.number}><td><button className="link" onClick={()=>onOpenRepair(row.id)} aria-label={`بازکردن پرونده ${row.number}`}>{new Intl.NumberFormat('fa-IR').format(Number(row.number)||0)}</button></td><td>{dateFormat.format(new Date(row.report_date+'T00:00:00Z'))}</td><td>{row.machine_code}</td><td>{row.title}{row.repairer_note&&<small>نظر تعمیرکار: {row.repairer_note}</small>}{row.note&&<small>توضیحات: {row.note}</small>}</td><td>{row.diagnoser||'—'}</td><td>{urgencyLabels[row.urgency] ?? row.urgency}</td><td>{row.shop || '—'}</td><td>{row.refer_date?dateFormat.format(new Date(row.refer_date+'T00:00:00Z')):'—'}</td><td>{row.expected_date?dateFormat.format(new Date(row.expected_date+'T00:00:00Z')):'—'}</td><td>{row.repair_completed_date?dateFormat.format(new Date(row.repair_completed_date+'T00:00:00Z')):'—'}</td><td>{row.test_completed_date?dateFormat.format(new Date(row.test_completed_date+'T00:00:00Z')):'—'}</td><td>{delay?`${new Intl.NumberFormat('fa-IR').format(delay)} روز${row.delay_reason?` · ${row.delay_reason}`:''}`:'—'}</td><td>{row.result === 'pass' ? 'تست قبول شد' : row.result === 'fail' ? 'تست رد شد' : stageName(row.stage)}{row.test_note&&<small>شرح تست: {row.test_note}</small>}</td></tr>;})}</tbody>
    </table></div></section>}
    {!busy && !error && !filtered.length && <p>پرونده‌ای با این فیلتر پیدا نشد.</p>}
  </>;
}
