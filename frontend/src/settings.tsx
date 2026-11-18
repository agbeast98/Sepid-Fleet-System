import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from './api';
import { Icon } from './shell';

type ActionRule = { min: number; max: number | null; action: string };
type AnalysisRules = Record<'driver'|'pm',Record<'low'|'mid'|'high',ActionRule[]>>;
type RepairStage = { id: string; label: string; kind: 'report'|'step'|'test'; mode: 'report'|'step'|'wait'|'done'|'test'; loc: 'factory'|'road'|'shop'|'part'|'done'; limit: number | null; who: string; desc: string };
const defaultStages: RepairStage[] = [
  { id: 'report', label: 'اعلام خرابی (ماشین در کارخانه)', kind: 'report', mode:'report', loc:'factory', limit: null, who:'سرپرست', desc:'خرابی ثبت شده و ماشین هنوز در کارخانه است' },
  { id: 'wait', label: 'در انتظار قطعه یا خدمات', kind: 'step', mode:'wait', loc:'part', limit: 7, who:'تعمیرات', desc:'ماشین برای تعمیر رفته و در انتظار تأمین قطعه یا انجام خدمات تعمیر است' },
  { id: 'done', label: 'پایان تعمیر', kind: 'step', mode:'done', loc:'shop', limit: 2, who:'تعمیرات', desc:'تعمیر تمام شده و ماشین باید در کارخانه تست سلامت شود' },
  { id: 'test', label: 'تست سلامت (ماشین در کارخانه)', kind: 'test', mode:'test', loc:'done', limit: null, who:'سرپرست', desc:'ماشین در کارخانه آزمایش می‌شود؛ اگر قبول شود پرونده بایگانی می‌شود و اگر رد شود خرابی جدید ثبت می‌شود' },
];
const stageLocations:Record<RepairStage['loc'],string>={factory:'ماشین در کارخانه',road:'در راه',shop:'در تعمیرگاه',part:'در انتظار قطعه یا خدمات',done:'تست سلامت'};
function normalizeStages(value:RepairStage[]|undefined):RepairStage[]{return (value??defaultStages).map(stage=>{const defaults=defaultStages.find(item=>item.id===stage.id);const mode=stage.mode??defaults?.mode??(stage.id==='report'?'report':stage.id==='test'?'test':stage.id==='wait'?'wait':stage.id==='done'?'done':'step');return {...defaults,...stage,label:stage.label??defaults?.label,kind:stage.kind??defaults?.kind,mode,loc:stage.loc??defaults?.loc??(mode==='report'?'factory':mode==='wait'?'part':mode==='done'?'shop':mode==='test'?'done':'shop'),who:stage.who||defaults?.who||'',desc:stage.desc||defaults?.desc||'',limit:stage.limit??defaults?.limit??null};});}
const defaultAnalysisRules:AnalysisRules={
  driver:{low:[{min:1,max:5,action:'تعهد کتبی'},{min:6,max:7,action:'کسر پاداش'},{min:8,max:null,action:'کسر حقوق'}],mid:[{min:1,max:5,action:'کسر پاداش'},{min:6,max:null,action:'کسر حقوق'}],high:[{min:1,max:1,action:'تعهد کتبی و کسر پاداش'},{min:2,max:null,action:'کسر حقوق'}]},
  pm:{low:[{min:1,max:5,action:'تعهد کتبی'},{min:6,max:7,action:'کسر پاداش'},{min:8,max:null,action:'کسر حقوق'}],mid:[{min:1,max:5,action:'کسر پاداش'},{min:6,max:null,action:'کسر حقوق'}],high:[{min:1,max:1,action:'تعهد کتبی و کسر پاداش'},{min:2,max:null,action:'کسر حقوق'}]},
};
type Settings = { revision: number; payload: { companyName: string; orgName: string; theme: 'auto' | 'light' | 'dark'; warnPercent: number; countWindow: 'all' | 'year' | '12m'; backupRemindDays: number; smsStageAlerts: boolean; analysisRules: AnalysisRules; stages: RepairStage[] }; updated_at: string };
const defaultSettings: Settings['payload'] = { companyName: 'شرکت دام و طیور سپید بستک', orgName: 'واحد ماشین‌آلات', theme: 'auto', warnPercent: 10, countWindow: 'all', backupRemindDays: 7, smsStageAlerts: false, analysisRules: defaultAnalysisRules, stages: defaultStages };
const ruleLabels={low:'کم‌اهمیت',mid:'نیمه‌حساس',high:'خیلی حساس'};

export function Settings({ onSettingsChange, onNavigate, availableSections, canManageDefinitions }: { onSettingsChange: (settings: Settings['payload']) => void; onNavigate: (section: 'machines'|'people'|'maintenance'|'parts'|'sms'|'guide') => void; availableSections: ('machines'|'people'|'maintenance'|'parts'|'sms')[]; canManageDefinitions: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings['payload']>(defaultSettings);
  const [tab,setTab]=useState<'general'|'stages'|'rules'>(()=>{const requested=sessionStorage.getItem('sepid-settings-tab');sessionStorage.removeItem('sepid-settings-tab');return requested==='stages'||requested==='rules'?requested:'general';});
  const [rulesRole,setRulesRole]=useState<'driver'|'pm'>('driver');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const saveQueue = useRef(Promise.resolve());
  const pendingSaves=useRef(0);
  const latestSettings = useRef<Settings | null>(null);
  const messageTimer=useRef<number|undefined>(undefined);
  const stagesDirty=!!settings&&JSON.stringify(draft.stages)!==JSON.stringify(settings.payload.stages);

  async function refresh() {
    setBusy(true); setError('');
    try {
      const value = await api<Settings>('/settings');
      const normalized = { ...defaultSettings, ...value.payload, stages: normalizeStages(value.payload.stages) };
      const current = { ...value, payload: normalized };
      latestSettings.current = current; setSettings(current); setDraft(normalized);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); return () => { if(messageTimer.current) window.clearTimeout(messageTimer.current); }; }, []);

  async function savePayload(payload: Settings['payload']) {
    if (!latestSettings.current) return;
    pendingSaves.current++; setBusy(true); setError(''); setMessage('');
    const operation = saveQueue.current.then(async () => {
      const current = latestSettings.current;
      if (!current) return;
      const saved = await api<Settings>('/settings', 'PUT', { ...payload, revision: current.revision });
      const normalized = { ...defaultSettings, ...saved.payload, stages: normalizeStages(saved.payload.stages) };
      const next = { ...saved, payload: normalized };
      latestSettings.current = next; setSettings(next);
      setDraft(current => ({ ...current, ...normalized }));
      onSettingsChange(normalized);
      setMessage('تنظیمات سامانه ذخیره شد.');
      if(messageTimer.current) window.clearTimeout(messageTimer.current);
      messageTimer.current=window.setTimeout(()=>setMessage(''),2800);
    });
    saveQueue.current = operation.catch(() => undefined);
    try { await operation; }
    catch (failure) { setError(errorMessage(failure)); }
    finally { pendingSaves.current--; setBusy(pendingSaves.current>0); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await savePayload(draft);
  }

  function saveGeneralField(payload: Settings['payload']) {
    void savePayload(payload);
  }

  function updateRule(role:'driver'|'pm',severity:'low'|'mid'|'high',index:number,patch:Partial<ActionRule>){
    if(!draft.analysisRules)return;
    const analysisRules={...draft.analysisRules,[role]:{...draft.analysisRules[role],[severity]:draft.analysisRules[role][severity].map((rule,row)=>row===index?{...rule,...patch}:rule)}};
    setDraft({...draft,analysisRules});
  }

  function addRule(role:'driver'|'pm',severity:'low'|'mid'|'high'){
    const current=draft.analysisRules[role][severity];
    const last=current[current.length-1];
    const min=last?(last.max===null?last.min+1:last.max+1):1;
    const rows=current.map((rule,index)=>index===current.length-1&&rule.max===null?{...rule,max:min-1}:rule);
    const analysisRules={...draft.analysisRules,[role]:{...draft.analysisRules[role],[severity]:[...rows,{min,max:null,action:''}]}};
    setDraft({...draft,analysisRules});
  }

  function removeRule(role:'driver'|'pm',severity:'low'|'mid'|'high',index:number){
    const analysisRules={...draft.analysisRules,[role]:{...draft.analysisRules[role],[severity]:draft.analysisRules[role][severity].filter((_,row)=>row!==index)}};
    setDraft({...draft,analysisRules});
  }

  function updateStage(index:number,label:string){setDraft({...draft,stages:draft.stages.map((stage,row)=>row===index?{...stage,label}:stage)});}
  function updateStageLimit(index:number,value:string){setDraft({...draft,stages:draft.stages.map((stage,row)=>row===index?{...stage,limit:value===''?null:Number(value)}:stage)});}
  function updateStageMode(index:number,mode:RepairStage['mode']){setDraft({...draft,stages:draft.stages.map((stage,row)=>row===index?{...stage,mode,loc:mode==='wait'?'part':mode==='done'?'shop':stage.loc}:stage)});}
  function updateStageField(index:number,field:'who'|'desc'|'loc',value:string){setDraft({...draft,stages:draft.stages.map((stage,row)=>row===index?{...stage,[field]:value}:stage)});}
  function addStage(afterIndex=draft.stages.length-2){
    if(draft.stages.length>=12)return;
    const stages=[...draft.stages];
    stages.splice(afterIndex+1,0,{id:`step_${crypto.randomUUID().slice(0,8)}`,label:'مرحلهٔ جدید',kind:'step',mode:'step',loc:'shop',limit:null,who:'',desc:''});
    setDraft({...draft,stages});
  }
  function removeStage(index:number){if(index<=0||index>=draft.stages.length-1)return;setDraft({...draft,stages:draft.stages.filter((_,row)=>row!==index)});}
  function moveStage(index:number,direction:-1|1){
    const target=index+direction;if(index<=0||target<=0||target>=draft.stages.length-1)return;
    const stages=[...draft.stages];[stages[index],stages[target]]=[stages[target],stages[index]];setDraft({...draft,stages});
  }

  return <>
    <header className="page-head"><div className="ph-text">{tab!=='general'&&<div className="settings-breadcrumb"><span>تنظیمات و تعاریف</span><span aria-hidden="true">‹</span><span>{tab==='rules'?'قوانین اقدامات مدیریتی':'مراحل وضعیت'}</span></div>}<h1>تنظیمات و تعاریف</h1><p>{tab==='rules'?'اقدام مدیریتی متناسب با تعداد دفعات سهل‌انگاری':tab==='stages'?'نام، ترتیب و تعداد مراحل؛ هر تغییری که اینجا ذخیره شود همه‌جای سایت (وضعیت ماشین‌ها، خرابی‌ها، پیامک و گزارش‌ها) عوض می‌شود':'همه تعریف‌های سامانه (ماشین، راننده، سرپرست، مدل، مراحل و قوانین) در این بخش است'}</p></div></header>
    {error && <p role="alert">{error}</p>}{message && <div className="toasts settings-toast" role="status"><div className="toast toast-ok in"><Icon name="circle-check"/>{message}</div></div>}
    {settings && <form onSubmit={save}>
      <nav className="set-tabs settings-tabs" aria-label="زبانه‌های تنظیمات" role="tablist">
        {([['general','عمومی','sliders'],['machines','ماشین‌ها','truck'],['people','پرسنل (راننده، سرپرست، PM)','users'],['models','مدل‌ها','layers'],['stages','مراحل وضعیت','route'],['rules','قوانین اقدامات مدیریتی','gavel']] as const).filter(([key])=>key==='general'||key==='machines'&&availableSections.includes('machines')||key==='people'&&availableSections.includes('people')||key==='models'&&canManageDefinitions||key==='stages'&&canManageDefinitions||key==='rules'&&canManageDefinitions).map(([key,label,icon])=><button type="button" role="tab" aria-selected={tab===key} className={tab===key?'on':''} key={key} onClick={()=>{if(key==='general'||key==='stages'||key==='rules')setTab(key);else {if(key==='models')sessionStorage.setItem('sepid-directory-focus','model');onNavigate(key==='people'?'people':'machines');}}}><Icon name={icon}/><span>{label}</span></button>)}
      </nav>
      {tab==='general'&&<section role="tabpanel" className="settings-tab-panel">
      <div className="settings-general-grid">
        <section className="card settings-card"><h3><Icon name="building-2"/> عمومی</h3>
          <label>نام شرکت<input aria-label="نام شرکت" required maxLength={180} value={draft.companyName} onChange={e => setDraft({ ...draft, companyName: e.target.value })} onBlur={e => saveGeneralField({ ...draft, companyName: e.target.value.trim() || defaultSettings.companyName })} /><small>در بالای منو، عنوان مرورگر و سربرگ همهٔ چاپ‌ها نمایش داده می‌شود.</small></label>
          <label>نام واحد<input aria-label="نام واحد" maxLength={120} value={draft.orgName} onChange={e => setDraft({ ...draft, orgName: e.target.value })} onBlur={e => saveGeneralField({ ...draft, orgName: e.target.value.trim() })} /><small>زیر نام شرکت در منو و چاپ‌ها</small></label>
          <div className="settings-inline-fields"><label>پوسته<select value={draft.theme} onChange={e => { const payload = { ...draft, theme: e.target.value as Settings['payload']['theme'] }; setDraft(payload); saveGeneralField(payload); }}><option value="auto">خودکار (مطابق ویندوز)</option><option value="light">روشن</option><option value="dark">تیره</option></select></label><label>یادآوری پشتیبان هر چند روز<input type="number" min={1} max={365} required value={draft.backupRemindDays} onChange={e => setDraft({ ...draft, backupRemindDays: Number(e.target.value) })} onBlur={e => saveGeneralField({ ...draft, backupRemindDays: Number(e.target.value) || 7 })} /></label></div>
        </section>
        <section className="card settings-card"><h3><Icon name="gauge"/> نگهداری پیشگیرانه</h3>
          <label>هشدار «نزدیک موعد» از چند درصد باقیمانده<input aria-label="درصد هشدار موعد نگهداری" type="number" min={1} max={90} required value={draft.warnPercent} onChange={e => setDraft({ ...draft, warnPercent: Number(e.target.value) })} onBlur={e => saveGeneralField({ ...draft, warnPercent: Math.max(1, Math.min(90, Number(e.target.value) || 10)) })} /><small>مثلاً ۱۰ یعنی وقتی ۱۰٪ از دوره باقی مانده، زرد شود.</small></label>
          <div className="set-quick settings-shortcuts">
            {([['machines','ماشین‌ها','truck'],['people','پرسنل (راننده، سرپرست، PM)','users'],['models','مدل‌ها','layers'],['stages','مراحل وضعیت','route'],['rules','قوانین اقدامات مدیریتی','gavel']] as const).filter(([key])=>key==='machines'?availableSections.includes('machines'):key==='people'?availableSections.includes('people'):canManageDefinitions).map(([key,label,icon])=><button type="button" key={key} onClick={()=>{if(key==='stages'||key==='rules')setTab(key);else {if(key==='models')sessionStorage.setItem('sepid-directory-focus','model');onNavigate(key==='people'?'people':'machines');}}}><Icon name={icon}/><span>{label}</span><Icon name="chevron-left"/></button>)}
          </div>
        </section>
        <section className="card settings-card settings-about"><div className="card-head"><h3><Icon name="info"/> دربارهٔ سامانه</h3><button type="button" className="link" onClick={()=>onNavigate('guide')}><Icon name="book-open"/> رویهٔ کار با سامانه <span aria-hidden="true">‹</span></button></div><p>این سامانه اطلاعات ناوگان را در پایگاه‌دادهٔ مشترک ذخیره می‌کند تا کاربران مجاز از داده‌های یکسان استفاده کنند. برای محافظت از پرونده‌ها، از بخش پشتیبان‌گیری نسخهٔ پشتیبان تهیه کنید.</p><p className="muted small">میان‌بر: <kbd>Ctrl</kbd> + <kbd>K</kbd> برای جست‌وجوی سریع در همهٔ بخش‌ها.</p></section>
      </div>
      </section>}
      {tab==='rules'&&<section role="tabpanel" className="settings-tab-panel">
        <section className="card settings-rules-card">
          <div className="card-head"><h3><Icon name="gavel"/>قوانین اقدامات مدیریتی</h3><div className="seg" role="group" aria-label="قوانین برای"><button type="button" className={rulesRole==='driver'?'on':''} aria-pressed={rulesRole==='driver'} onClick={()=>setRulesRole('driver')}>راننده</button><button type="button" className={rulesRole==='pm'?'on':''} aria-pressed={rulesRole==='pm'} onClick={()=>setRulesRole('pm')}>مسئول PM</button></div></div>
          <p className="muted small">بر اساس تعداد دفعات سهل‌انگاری هر نفر در هر سطح حساسیت، اقدام مدیریتی تعیین می‌شود.</p>
          <div className="settings-rules-grid">
            {(['low','mid','high'] as const).map(severity=><section className={`settings-rule-edit sev-${severity}`} data-rule-severity={severity} key={severity}>
              <div className="settings-rule-head"><span className={`sev sev-${severity}`}><i/>{ruleLabels[severity]}</span><button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={()=>addRule(rulesRole,severity)}><Icon name="plus"/>ردیف</button></div>
              <div className="settings-rule-rows"><div className="settings-rule-row settings-rule-labels"><span>از (بار)</span><span>تا (بار)</span><span>اقدام مدیریتی</span><span/></div>
                {draft.analysisRules[rulesRole][severity].map((rule,index)=><div className="settings-rule-row" key={`${rulesRole}-${severity}-${index}`}>
                  <input aria-label={`${ruleLabels[severity]} از چندمین مورد`} type="number" min="1" required value={rule.min} onChange={event=>updateRule(rulesRole,severity,index,{min:Number(event.target.value)})}/>
                  <input aria-label={`${ruleLabels[severity]} تا چندمین مورد`} type="number" min={rule.min} value={rule.max??''} placeholder="به بالا" onChange={event=>updateRule(rulesRole,severity,index,{max:event.target.value===''?null:Number(event.target.value)})}/>
                  <input aria-label={`${ruleLabels[severity]} اقدام مدیریتی`} required maxLength={200} value={rule.action} onChange={event=>updateRule(rulesRole,severity,index,{action:event.target.value})}/>
                  <button type="button" className="icon-btn sm danger" disabled={busy} aria-label={`حذف بازه ${ruleLabels[severity]} ${index+1}`} onClick={()=>removeRule(rulesRole,severity,index)}><Icon name="x"/></button>
                </div>)}
              </div>
            </section>)}
          </div>
          <div className="settings-rule-window"><label>بازه شمارش دفعات<select value={draft.countWindow} onChange={e => setDraft({ ...draft, countWindow: e.target.value as Settings['payload']['countWindow'] })}><option value="all">از ابتدای ثبت سوابق (مانند اکسل)</option><option value="year">فقط در همان سال شمسی (هر سال از صفر)</option><option value="12m">۱۲ ماه منتهی به هر بررسی</option></select></label></div>
          <div className="toolbar settings-rules-actions"><button type="button" disabled={busy} onClick={()=>setDraft({...draft,analysisRules:{...draft.analysisRules,[rulesRole]:defaultAnalysisRules[rulesRole]}})}>بازگشت به قوانین اکسل</button><button type="submit" disabled={busy}>ذخیره قوانین</button></div>
        </section>
      </section>}
      {tab==='stages'&&<section role="tabpanel" className="settings-tab-panel">
        <section className="card settings-stages-card"><div className="card-head"><h3><Icon name="route"/>مراحل وضعیت ماشین</h3><span className="muted small">مرحله اول (اعلام خرابی) و آخر (تست سلامت) ثابت‌اند؛ بین آن‌ها هر مرحله‌ای خواستید اضافه کنید</span></div>
          {draft.stages.map((stage,index)=>{const first=index===0,last=index===draft.stages.length-1;return <div className="settings-stage-wrap" key={stage.id}>
            <section className={`settings-stage-card ${first?'settings-stage-report':last?'settings-stage-test':`settings-stage-${stage.mode}`}`} data-stage-id={stage.id}>
              <span className="settings-stage-number" aria-hidden="true">{index+1}</span>
              <div className="settings-stage-fields">
                <label>{first?'مرحله آغاز':last?'مرحله پایانی':'نام مرحله'}<input aria-label={first?'مرحلهٔ آغاز':last?'مرحلهٔ پایانی':'نام مرحله'} required maxLength={60} value={stage.label} onChange={event=>updateStage(index,event.target.value)} /></label>
                {first||last?<label>نوع مرحله<span className="settings-stage-fixed">{first?'شروع: اعلام خرابی':'پایان: تست سلامت'}</span></label>:<label>نوع مرحله<select aria-label={`نوع عملیات ${stage.label}`} value={stage.mode} onChange={event=>updateStageMode(index,event.target.value as RepairStage['mode'])}><option value="step">مرحلهٔ ساده</option><option value="wait">انتظار قطعه یا خدمات</option><option value="done">پایان تعمیر</option></select></label>}
                {first||last?<label>ماشین کجاست؟<span className="settings-stage-fixed">ماشین در کارخانه</span></label>:<label>محل ماشین<select aria-label={`محل ماشین ${stage.label}`} value={stage.loc} onChange={event=>updateStageField(index,'loc',event.target.value)}>{Object.entries(stageLocations).filter(([key])=>key!=='factory'||stage.mode==='step').map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>}
                <label>حد مجاز (روز){first||last?<span className="settings-stage-fixed">{last?'بدون محدودیت':'سطح ضرورت'}</span>:<input aria-label="حداکثر مجاز (روز؛ خالی = بدون سقف)" type="number" min={1} max={365} value={stage.limit??''} onChange={event=>updateStageLimit(index,event.target.value)} />}</label>
                <label>توضیح کوتاه مرحله<input aria-label="توضیح کوتاه مرحله" maxLength={500} value={stage.desc} onChange={event=>updateStageField(index,'desc',event.target.value)} /></label>
                <label>چه کسی این مرحله را ثبت می‌کند؟<input aria-label="چه کسی این مرحله را ثبت می‌کند؟" maxLength={80} value={stage.who} onChange={event=>updateStageField(index,'who',event.target.value)} /></label>
                <small className="settings-stage-note">{first?'مرحلهٔ اول؛ با «اعلام خرابی» ثبت می‌شود و جابه‌جا یا حذف نمی‌شود.':last?'مرحلهٔ آخر؛ قبولی بایگانی می‌شود و رد، پروندهٔ خرابی تازه می‌سازد.':'فقط توضیح (و نام تعمیرگاه اگر بیرون از کارخانه است)'}</small>
              </div>
              {!first&&!last&&<div className="settings-stage-tools"><button type="button" disabled={busy||index===1} aria-label="انتقال مرحله به بالا" onClick={()=>moveStage(index,-1)}><Icon name="arrow-up"/></button><button type="button" disabled={busy||index===draft.stages.length-2} aria-label="انتقال مرحله به پایین" onClick={()=>moveStage(index,1)}><Icon name="arrow-down"/></button><button type="button" disabled={busy||draft.stages.length<=3} aria-label="حذف مرحله" onClick={()=>removeStage(index)}><Icon name="trash-2"/></button></div>}
            </section>
            {!last&&<button type="button" className="settings-add-stage" disabled={busy||draft.stages.length>=12} onClick={()=>addStage(index)}><Icon name="plus"/>افزودن مرحله اینجا</button>}
          </div>;})}
          <div className="toolbar settings-stage-actions"><button type="button" disabled={busy} onClick={()=>setDraft({...draft,stages:defaultStages})}>مراحل پیش‌فرض</button>{stagesDirty&&<button type="button" disabled={busy} onClick={()=>setDraft({...draft,stages:settings!.payload.stages})}>لغو تغییرات</button>}<button type="submit" disabled={busy}>ذخیره مراحل</button></div>
        </section>
      </section>}
    </form>}
  </>;
}
