import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from './api';

type SmsMessage = { id: string; recipient: string; message: string; status: 'queued' | 'sending' | 'accepted' | 'failed' | 'unconfirmed'; provider: string; provider_message_id: string; response_code: number | null; attempts: number; retry_of: string|null; retry_count:number; created_at: string };
type SmsSettings = { lineNumber:string;loginTemplateId:number|null;keyStored:boolean;ippanelKeyStored:boolean;ippanelSender:string;ippanelLoginPatternCode:string;ippanelNameParameter:string;ippanelCodeParameter:string;selectedProvider:string;enabled:boolean;storageReady:boolean };
type SmsState = { provider: string; configured: boolean; messages: SmsMessage[]; smsSettings?: SmsSettings };
type SmsRecipient={name:string;role:string;phone:string};
type Stage={id:string;label:string;kind:'report'|'step'|'test';limit:number|null};
type SmsRule={on:boolean;to:string[];text:string;pattern:{templateId:number|null;ippanelCode:string;bindings:Record<string,string>}};
type SmsRulesState={revision:number;enabled:boolean;stages:Stage[];rules:Record<string,SmsRule>};
type IPPanelPattern={code:string;title:string;body:string;variables:string[]};
const recipientOptions=[['supervisor','سرپرست همان ماشین'],['pm','مسئول PM همان ماشین'],['admin','مدیر کل']] as const;
const sampleVariables:Record<string,string>={'ماشین':'کامیون ۱۲','پلاک':'۱۲الف۳۴۵','خرابی':'نشتی روغن','مرحله':'در انتظار قطعه','تاریخ':'۱۴۰۵/۰۸/۲۲','ساعت':'۱۰:۳۰','ثبت‌کننده':'مسئول ماشین‌آلات','تعمیرگاه':'تعمیرگاه مرکزی','قطعه':'پمپ آب','تحویل قطعه':'۱۴۰۵/۰۸/۲۴','نتیجه تست':'قبول','توضیح':'نمونه توضیحات'};
function previewTemplate(template:string){const fill=(value:string)=>value.replace(/«([^»]+)»/g,(_match,key:string)=>sampleVariables[key]??'');return fill(template.replace(/\[([^\[\]]*)\]/g,(_match,segment:string)=>{const keys=[...segment.matchAll(/«([^»]+)»/g)].map(match=>match[1]);return keys.some(key=>!(sampleVariables[key]??'').trim()&&key!=='قطعه')?'':fill(segment);}));}
const statuses = { queued: 'در صف ارسال', sending: 'در حال ارسال', accepted: 'پذیرفته‌شده توسط سرویس', failed: 'ناموفق', unconfirmed: 'وضعیت نامشخص' };
const providerNames: Record<string, string> = { mock: 'شبیه‌ساز توسعه', kavenegar: 'کاوه‌نگار', smsir: 'SMS.ir', ippanel:'IPPanel' };
const smsIrDeliveryLabels: Record<number, string> = {
  1: 'تحویل به گوشی',
  2: 'نرسیده به گوشی',
  3: 'رسیده به مخابرات',
  4: 'نرسیده به مخابرات',
  5: 'رسیده به اپراتور',
  6: 'ناموفق',
  7: 'لیست سیاه',
  8: 'نامشخص',
};
const dateFmt = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' });

export function Sms() {
  const [state, setState] = useState<SmsState | null>(null);
  const [providerDraft,setProviderDraft]=useState('mock');
  const [rulesState,setRulesState]=useState<SmsRulesState|null>(null);
  const [rulesDraft,setRulesDraft]=useState<Record<string,SmsRule>>({});
  const [recipients,setRecipients]=useState<SmsRecipient[]>([]);
  const [selectedStage,setSelectedStage]=useState('report');
  const [savingRules,setSavingRules]=useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [ippanelPatterns,setIppanelPatterns]=useState<IPPanelPattern[]>([]);
  const [loadingPatterns,setLoadingPatterns]=useState(false);
  const [testStage,setTestStage]=useState<Stage|null>(null);
  const [sendingStageTest,setSendingStageTest]=useState(false);
  const [otpTestOpen,setOtpTestOpen]=useState(false);
  const [sendingOtpTest,setSendingOtpTest]=useState(false);

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const selectedProvider=String(fields.get('provider')??'mock');
    const enabled = fields.has('enabled')&&selectedProvider!=='mock';
    if (enabled && (!state?.smsSettings?.enabled||state.smsSettings.selectedProvider!==selectedProvider) && !window.confirm(`با فعال‌کردن ${providerNames[selectedProvider]??selectedProvider}، پیامک‌های آزمایشی و اعلان‌هایی که قوانین ارسالشان روشن است ممکن است واقعی ارسال شوند و هزینه داشته باشند. ادامه می‌دهید؟`)) return;
    setSavingProvider(true);
    setError('');
    setStatus('');
    try {
      await api<SmsSettings>('/sms/provider', 'PUT', { provider:selectedProvider,apiKey: fields.get('apiKey'), lineNumber: fields.get('lineNumber'), loginTemplateId:fields.get('loginTemplateId'),
        ippanelSender:fields.get('ippanelSender'),ippanelLoginPatternCode:fields.get('ippanelLoginPatternCode'),ippanelNameParameter:fields.get('ippanelNameParameter'),ippanelCodeParameter:fields.get('ippanelCodeParameter'),enabled });
      const keyField = form.elements.namedItem('apiKey');
      if (keyField instanceof HTMLInputElement) keyField.value = '';
      await refresh();
      setStatus(`تنظیمات ${providerNames[selectedProvider]??'پیامک'} ذخیره شد.`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSavingProvider(false);
    }
  }

  async function checkDelivery(messageId: string) {
    setDeliveryBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await api<{ state: number | null; status?:string|null; time: string | null;provider?:string }>(`/sms/${messageId}/delivery`);
      const ippanelLabels:Record<number,string>={0:'در حال ایجاد',1:'در صف بررسی',2:'در حال ارسال',3:'رد شده توسط سامانه',4:'شماره گیرنده نامعتبر',5:'در صف ارسال',6:'ارسال موفق به اپراتور',7:'لغوشده',8:'اعتبار ناکافی',9:'خطای سامانه'};
      const state = result.provider==='ippanel'
        ?result.state===null?'IPPanel هنوز وضعیت نهایی نداده است.':`IPPanel: ${ippanelLabels[result.state]??result.status??`وضعیت ${result.state}`} · کد ${result.state}`
        :result.state === null ? 'سرویس هنوز وضعیت تحویل اعلام نکرده است.'
          : smsIrDeliveryLabels[result.state] ?? `کد وضعیت تحویل در SMS.ir: ${result.state}`;
      setStatus(result.time ? `${state} · زمان اعلام‌شده: ${dateFmt.format(new Date(result.time))}` : state);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setDeliveryBusy(false);
    }
  }

  async function sendOtpTest(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const recipient=String(new FormData(event.currentTarget).get('recipient')??'').trim();
    if(!window.confirm(`یک پیامک واقعی OTP از طریق IPPanel به ${recipient} ارسال شود؟ ممکن است هزینه داشته باشد.`))return;
    setSendingOtpTest(true);setError('');setStatus('');
    try{await api<SmsMessage>('/sms/otp/test','POST',{recipient});setOtpTestOpen(false);setStatus('درخواست تست OTP در صف ارسال IPPanel قرار گرفت.');await refresh();}
    catch(failure){setError(errorMessage(failure));}
    finally{setSendingOtpTest(false);}
  }

  async function refresh() {
    setBusy(true); setError('');
    try { const [current,contacts]=await Promise.all([api<SmsState>('/sms'),api<SmsRecipient[]>('/sms/recipients')]);setState(current);setProviderDraft(current.smsSettings?.selectedProvider??current.provider);setRecipients(contacts); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(()=>{api<SmsRulesState>('/sms/rules').then(value=>{setRulesState(value);setRulesDraft(value.rules);}).catch(failure=>setError(errorMessage(failure)));},[]);
  useEffect(() => {
    if (!state?.messages.some(item => item.status === 'queued' || item.status === 'sending')) return;
    const timer = window.setTimeout(() => void refresh(), 1200);
    return () => window.clearTimeout(timer);
  }, [state?.messages]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!state?.configured) return;
    if (state.provider !== 'mock' && !window.confirm('این پیام از پنل واقعی ارسال می‌شود و ممکن است هزینه داشته باشد. ارسال انجام شود؟')) return;
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await api<SmsMessage>('/sms/test', 'POST', { ...fields, expectedProvider: state.provider });
      setStatus(result.provider === 'mock' ? 'پیام آزمایشی در صف شبیه‌ساز قرار گرفت؛ پیام واقعی ارسال نمی‌شود.' : 'پیام در صف ارسال قرار گرفت. وضعیت نهایی را در گزارش ببینید.');
      form.reset();
      await refresh();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function retryMessage(item:SmsMessage){
    if(item.provider!=='mock'&&!window.confirm('سرویس خطای قطعی داده است. پیام دوباره از پنل واقعی فرستاده می‌شود و ممکن است هزینه داشته باشد. ادامه می‌دهید؟'))return;
    setBusy(true);setError('');setStatus('');
    try{await api<SmsMessage>(`/sms/${item.id}/retry`,'POST',{});setStatus('ارسال دوباره پیامک در صف قرار گرفت.');await refresh();}
    catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}
  }

  function updateRule(stageId:string,patch:Partial<SmsRule>){setRulesDraft(current=>({...current,[stageId]:{...current[stageId],...patch}}));}
  async function saveRules(){if(!rulesState)return;setSavingRules(true);setError('');setStatus('');try{const rules=Object.fromEntries(Object.entries(rulesDraft).map(([id,rule])=>[id,{...rule,pattern:rule.pattern?.templateId||rule.pattern?.ippanelCode?rule.pattern:null}]));const saved=await api<SmsRulesState>('/sms/rules','PUT',{revision:rulesState.revision,enabled:rulesState.enabled,rules});setRulesState(saved);setRulesDraft(saved.rules);setStatus('قوانین و قالب‌های پیامک برای همهٔ کاربران ذخیره شد.');}catch(failure){setError(errorMessage(failure));}finally{setSavingRules(false);}}

  function updatePatternBinding(stageId:string, raw:string){
    const bindings:Record<string,string>={};
    for(const line of raw.split(/\r?\n/)){const match=/^\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*=\s*(.+?)\s*$/.exec(line);if(match)bindings[match[1]]=match[2].replace(/^«|»$/g,'').trim();}
    updateRule(stageId,{pattern:{...rulesDraft[stageId].pattern,bindings}});
  }
  async function loadIPPanelPatterns(){setLoadingPatterns(true);setError('');try{setIppanelPatterns(await api<IPPanelPattern[]>('/sms/ippanel/patterns'));setStatus('فهرست قالب‌های فعال IPPanel دریافت شد.');}catch(failure){setError(errorMessage(failure));}finally{setLoadingPatterns(false);}}
  async function sendStageTest(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!testStage)return;const recipient=String(new FormData(event.currentTarget).get('recipient')??'');if(state?.provider!=='mock'&&!window.confirm(`پیام تست «${testStage.label}» به شماره ${recipient} از ${providerNames[state?.provider??'']??'پنل پیامک'} ارسال می‌شود و ممکن است هزینه داشته باشد. ارسال شود؟`))return;setSendingStageTest(true);setError('');setStatus('');try{const item=await api<SmsMessage>('/sms/test-stage','POST',{recipient,stage:testStage.id});setStatus(item.provider==='mock'?'پیام نمونه در شبیه‌ساز ثبت شد و پیام واقعی ارسال نشد.':'پیام پترنی در صف ارسال قرار گرفت. وضعیت را در گزارش دنبال کنید.');setTestStage(null);await refresh();}catch(failure){setError(errorMessage(failure));}finally{setSendingStageTest(false);}}

  const selected=rulesState?.stages.find(stage=>stage.id===selectedStage)??rulesState?.stages[0];
  const selectedRule=selected?rulesDraft[selected.id]:undefined;
  const panelMode=providerDraft==='ippanel';
  return <section className="page sms-page">
    <header className="page-head"><div className="ph-text"><h1>پیامک</h1><p>با روشن بودن ارسال خودکار، پیام هر مرحله برای گیرندگان همان مرحله در صف قرار می‌گیرد.</p></div><div className="ph-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => void refresh()}>تازه‌سازی</button></div></header>
    {error && <p role="alert">{error}</p>}{status && <div className="toasts" role="status"><div className="toast toast-ok in">{status}</div></div>}
    {state&&<>
      <div className="sms-top">
        <div className="sms-stack">
          {state.smsSettings && <section className="card">
            <div className="card-head"><h3>تنظیم اتصال پنل پیامکی</h3></div>
            <p className="muted small">کلید API رمز‌شده در سرور نگه‌داری می‌شود. برای IPPanel، شمارهٔ فرستنده باید خط فعال و مجاز همان حساب باشد؛ قالب پترن هم باید در پنل تأیید شده باشد.</p>
            {!state.smsSettings.storageReady && <p role="status">ابتدا کلید رمزنگاری تنظیمات پیامک باید روی سرور تعریف شود.</p>}
            <form className="sms-test-form" key={JSON.stringify(state.smsSettings)} onSubmit={saveProvider}>
              <fieldset disabled={savingProvider || !state.smsSettings.storageReady}>
                <div className="fields">
                  <label>درگاه پیامک<select name="provider" value={providerDraft} onChange={event=>setProviderDraft(event.target.value)}><option value="mock">شبیه‌ساز (بدون ارسال واقعی)</option><option value="ippanel">IPPanel</option><option value="smsir">SMS.ir (قدیمی)</option></select></label>
                  <label>کلید API پنل<input className="input" name="apiKey" type="password" dir="ltr" autoComplete="new-password" maxLength={256} placeholder={providerDraft==='ippanel'?(state.smsSettings.ippanelKeyStored?'ذخیره شده؛ برای حفظ خالی بگذارید':'کلید API پنل IPPanel'):state.smsSettings.keyStored?'ذخیره شده؛ برای حفظ خالی بگذارید':'کلید API'} required={providerDraft==='ippanel'?!state.smsSettings.ippanelKeyStored:providerDraft==='smsir'?!state.smsSettings.keyStored:false}/></label>
                  {providerDraft==='ippanel'?<>
                    <label>شمارهٔ فرستندهٔ فعال IPPanel<input className="input" name="ippanelSender" dir="ltr" maxLength={30} placeholder="+983000505 یا 3000505" defaultValue={state.smsSettings.ippanelSender} required={state.smsSettings.enabled}/><small>شماره با یا بدون +۹۸ پذیرفته می‌شود و هنگام ذخیره به قالب موردنیاز IPPanel تبدیل می‌شود.</small></label>
                    <label>کد پترن ورود OTP<input className="input" name="ippanelLoginPatternCode" list="ippanel-pattern-list" dir="ltr" maxLength={128} placeholder="کد قالب فعال در پنل" defaultValue={state.smsSettings.ippanelLoginPatternCode}/><small>پارامترهای قالب ورود از فیلدهای نام و کد زیر گرفته می‌شوند.</small></label>
                    <label>نام متغیر نام کاربر (در صورت وجود در پترن)<input className="input" name="ippanelNameParameter" dir="ltr" maxLength={40} pattern="[A-Za-z][A-Za-z0-9_]{0,39}" defaultValue={state.smsSettings.ippanelNameParameter}/><small>اگر قالب فقط متغیر code دارد، این فیلد را خالی بگذارید.</small></label>
                    <label>نام متغیر کد ورود<input className="input" name="ippanelCodeParameter" dir="ltr" maxLength={40} pattern="[A-Za-z][A-Za-z0-9_]{0,39}" defaultValue={state.smsSettings.ippanelCodeParameter}/></label>
                    <button className="btn btn-ghost" type="button" disabled={!state.smsSettings.enabled||state.smsSettings.selectedProvider!=='ippanel'||!state.smsSettings.ippanelKeyStored||!state.smsSettings.ippanelLoginPatternCode||busy} onClick={()=>setOtpTestOpen(true)}>تست ارسال OTP به شماره دلخواه</button>
                  </>:<>
                    <label>شمارهٔ خط ارسال SMS.ir<input className="input" name="lineNumber" dir="ltr" inputMode="numeric" pattern="[1-9][0-9]{0,15}" maxLength={16} defaultValue={state.smsSettings.lineNumber}/></label>
                    <label>شناسهٔ پترن ورود OTP<input className="input" name="loginTemplateId" type="number" min="1" dir="ltr" defaultValue={state.smsSettings.loginTemplateId??''}/><small>در SMS.ir قالب تأییدشده با پارامترهای NAME و CODE تعریف کنید.</small></label>
                  </>}
                </div>
                {providerDraft==='ippanel'&&<div className="ippanel-pattern-tools"><button className="btn btn-ghost" type="button" disabled={loadingPatterns||!state.smsSettings.ippanelKeyStored} onClick={()=>void loadIPPanelPatterns()}>{loadingPatterns?'در حال دریافت قالب‌ها…':'دریافت قالب‌های فعال از IPPanel'}</button>{ippanelPatterns.length>0&&<span className="muted small">{new Intl.NumberFormat('fa-IR').format(ippanelPatterns.length)} قالب فعال دریافت شد.</span>}<datalist id="ippanel-pattern-list">{ippanelPatterns.map(pattern=><option key={pattern.code} value={pattern.code}>{pattern.title} · {pattern.variables.join('، ')}</option>)}</datalist></div>}
                {providerDraft!=='mock'&&<label className="check"><input name="enabled" type="checkbox" defaultChecked={state.smsSettings.enabled}/>فعال‌سازی ارسال واقعی از {providerNames[providerDraft]}</label>}
                <button className="btn btn-primary" type="submit">{savingProvider?'در حال ذخیره…':'ذخیره تنظیمات پیامک'}</button>
              </fieldset>
            </form>
          </section>}
          <section className="card"><div className="card-head"><h3>سرویس پیامک</h3><span className={`st ${state.configured?'st-good':'st-muted'}`}>{state.configured?'روشن':'خاموش'}</span></div><p className="sms-service-line">سرویس فعال: {providerNames[state.provider] ?? 'سرویس ناشناخته'} · {state.configured?'پیکربندی‌شده':'نیازمند تنظیم در سرور'}</p><p className="muted small">کلید سرویس در سرور نگه‌داری می‌شود و به مرورگر فرستاده نمی‌شود. پاسخ پذیرفته‌شده تضمین تحویل پیام نیست.</p><form className="sms-test-form" onSubmit={send}><h4>ارسال پیامک آزمایشی</h4><div className="fields"><label>شماره گیرنده<input name="recipient" type="tel" inputMode="tel" dir="ltr" required maxLength={30} placeholder="0912…" /></label><label>متن پیام<textarea name="message" required maxLength={1000} rows={2}/></label></div><button className="btn btn-primary" disabled={busy||!state.configured}>ارسال پیامک آزمایشی</button></form></section>
          <section className="card"><div className="card-head"><h3>شماره موبایل گیرنده‌ها</h3></div><ul className="phone-list">{recipients.length?recipients.map((item,index)=><li key={`${item.name}-${index}`}><span><b>{item.name}</b><small>{item.role}</small></span>{item.phone?<bdi dir="ltr">{item.phone}</bdi>:<span className="st st-warn">شماره ثبت نشده</span>}</li>):<li className="muted">گیرنده‌ای تعریف نشده</li>}</ul><p className="muted small">شمارهٔ سرپرست و مسئول PM از پروندهٔ پرسنلی یا حساب مرتبط خوانده می‌شود.</p></section>
        </div>
        <section className="card phone-card"><div className="phone"><div className="phone-in"><div className="phone-head"><span className="ph-av">س</span><b>سامانه ناوگان</b><small>نمونه پیامک «{selected?.label??'مرحله'}»</small></div><div className="phone-body"><div className="bubble">{previewTemplate(selectedRule?.text??'')||'نمونه پیامک مرحله در این‌جا نمایش داده می‌شود'}<small>۱۰:۳۰</small></div></div></div></div><p className="muted small">روی هر ردیف جدول زیر بزنید تا نمونهٔ آن اینجا دیده شود.</p></section>
      </div>
      {rulesState&&<section className="card flush"><div className="card-head pad"><h3>کدام مرحله، برای چه کسی پیامک بفرستد؟</h3><div className="sms-rule-actions"><label className="check"><input type="checkbox" checked={rulesState.enabled} onChange={event=>setRulesState({...rulesState,enabled:event.target.checked})}/> ارسال خودکار روشن باشد</label><button className="btn btn-sm btn-primary" disabled={savingRules||busy} onClick={()=>void saveRules()}>{savingRules?'در حال ذخیره…':'ذخیره قوانین'}</button></div></div><div className="table-wrap"><table className="sms-rules-table"><thead><tr><th>مرحله</th><th>پیامک</th><th>گیرنده‌ها</th><th>متن پیش‌نمایش</th><th>{panelMode?'کد پترن IPPanel':'شناسهٔ پترن SMS.ir'}</th><th>آزمایش</th></tr></thead><tbody>{rulesState.stages.map(stage=>{const rule=rulesDraft[stage.id];if(!rule)return null;const pattern=rule.pattern??{templateId:null,ippanelCode:'',bindings:{}};const hasPattern=panelMode?!!pattern.ippanelCode:!!pattern.templateId;return <tr key={stage.id} className={selectedStage===stage.id?'sel':''} onClick={()=>setSelectedStage(stage.id)}><td><b>{stage.label}</b><small>{stage.kind==='report'?'اعلام خرابی':stage.kind==='test'?'تست سلامت':'مرحلهٔ تعمیر'}</small></td><td><label className="switch"><input aria-label={`فعال‌سازی ${stage.label}`} type="checkbox" checked={rule.on} onClick={event=>event.stopPropagation()} onChange={event=>updateRule(stage.id,{on:event.target.checked})}/><span className="sw"/></label></td><td><div className="to-pick">{recipientOptions.map(([key,label])=><label className={`tchip ${rule.to.includes(key)?'on':''}`} key={key} onClick={event=>event.stopPropagation()}><input type="checkbox" checked={rule.to.includes(key)} onChange={event=>updateRule(stage.id,{to:event.target.checked?[...new Set([...rule.to,key])]:rule.to.filter(item=>item!==key)})}/>{label}</label>)}</div></td><td><textarea aria-label={`قالب پیام ${stage.label}`} className="sms-tpl" rows={2} maxLength={1000} value={rule.text} onClick={event=>event.stopPropagation()} onChange={event=>updateRule(stage.id,{text:event.target.value})}/></td><td onClick={event=>event.stopPropagation()}>{panelMode?<label>کد فعال قالب<input className="input" list="ippanel-pattern-list" dir="ltr" maxLength={128} value={pattern.ippanelCode} onChange={event=>updateRule(stage.id,{pattern:{...pattern,ippanelCode:event.target.value}})}/></label>:<label>شناسه قالب<input className="input" type="number" min="1" value={pattern.templateId??''} onChange={event=>updateRule(stage.id,{pattern:{...pattern,templateId:event.target.value?Number(event.target.value):null}})}/></label>}<label>پارامترها، هر خط نام=متغیر<textarea className="sms-tpl" rows={3} placeholder={'CODE=مرحله\nMACHINE=ماشین'} value={Object.entries(pattern.bindings).map(([name,key])=>`${name}=${key}`).join('\n')} onChange={event=>updatePatternBinding(stage.id,event.target.value)}/></label></td><td><button className="btn btn-sm" type="button" disabled={!hasPattern} title={!hasPattern?'ابتدا کد/شناسه قالب را وارد کنید':''} onClick={event=>{event.stopPropagation();setSelectedStage(stage.id);setTestStage(stage);}}>ارسال تست</button></td></tr>})}</tbody></table></div><div className="table-foot">{panelMode?'برای IPPanel کد قالب فعال را از پنل انتخاب کنید؛ کلید متغیرها باید دقیقاً با متغیرهای قالب یکی باشد.':'برای SMS.ir شناسهٔ قالب تأییدشده را وارد کنید.'} مقادیر از پرونده جای‌گذاری می‌شوند. ارسال خودکار فقط برای مراحل روشن در صف قرار می‌گیرد.</div></section>}
      <section className="card flush"><div className="card-head pad"><h3>گزارش ارسال پیامک</h3><span className="count">{new Intl.NumberFormat('fa-IR').format(state.messages.length)} پیامک</span></div>{state.messages.length?<div className="table-wrap"><table className="sms-log-table"><thead><tr><th>زمان</th><th>درگاه</th><th>گیرنده</th><th>متن</th><th>نتیجه</th><th>شناسهٔ سرویس</th><th>عملیات</th></tr></thead><tbody>{state.messages.map(item=><tr key={item.id}><td className="muted">{dateFmt.format(new Date(item.created_at))}</td><td>{providerNames[item.provider]??item.provider}</td><td dir="ltr">{item.recipient}</td><td>{item.message}</td><td>{statuses[item.status]}</td><td dir="ltr">{item.provider_message_id||'—'}</td><td>{['smsir','ippanel'].includes(item.provider)&&item.provider_message_id&&<button type="button" disabled={deliveryBusy} onClick={()=>void checkDelivery(item.id)}>استعلام وضعیت</button>}{item.status==='failed'&&!item.provider_message_id&&item.retry_count<2&&<button type="button" disabled={busy||!state.configured} onClick={()=>void retryMessage(item)}>ارسال دوباره</button>}</td></tr>)}</tbody></table></div>:<div className="empty"><h4>هنوز پیامکی فرستاده نشده</h4><p>با ثبت مراحلی که پیامک دارند، پیامک‌ها اینجا ثبت می‌شوند.</p></div>}</section>
    </>}
    {testStage&&<div className="sms-test-overlay" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setTestStage(null);}}><section className="card sms-test-dialog" role="dialog" aria-modal="true" aria-labelledby="sms-stage-test-title"><div className="card-head"><h3 id="sms-stage-test-title">ارسال تست پترن · {testStage.label}</h3><button type="button" className="btn btn-ghost" onClick={()=>setTestStage(null)}>بستن</button></div><p className="muted small">یک شماره وارد کنید. پیش از ارسال واقعی، سامانه تأیید می‌گیرد؛ ارسال ممکن است هزینه داشته باشد.</p><div className="sms-test-preview"><b>متن نمونه</b><p>{previewTemplate(rulesDraft[testStage.id]?.text??'')||'نمونه متن تنظیم نشده است.'}</p></div><form onSubmit={sendStageTest}><label>شماره موبایل<input name="recipient" type="tel" dir="ltr" inputMode="tel" required maxLength={30} placeholder="0912…" autoFocus/></label><div className="sms-test-actions"><button type="button" className="btn" onClick={()=>setTestStage(null)}>انصراف</button><button className="btn btn-primary" disabled={sendingStageTest}>{sendingStageTest?'در حال ثبت…':'ارسال تست'}</button></div></form></section></div>}
    {otpTestOpen&&<div className="sms-test-overlay" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setOtpTestOpen(false);}}><section className="card sms-test-dialog" role="dialog" aria-modal="true" aria-labelledby="sms-otp-test-title"><div className="card-head"><h3 id="sms-otp-test-title">تست پترن ورود OTP · IPPanel</h3><button type="button" className="btn btn-ghost" onClick={()=>setOtpTestOpen(false)}>بستن</button></div><p className="muted small">یک کد شش‌رقمی آزمایشی با همان پترن ورود به شماره واردشده می‌رود. قبل از ارسال، تأیید می‌گیریم؛ ممکن است هزینه داشته باشد.</p><form onSubmit={sendOtpTest}><label>شماره موبایل گیرنده<input name="recipient" type="tel" dir="ltr" inputMode="tel" required maxLength={30} placeholder="0912…" autoFocus/></label><div className="sms-test-actions"><button type="button" className="btn" onClick={()=>setOtpTestOpen(false)}>انصراف</button><button className="btn btn-primary" disabled={sendingOtpTest}>{sendingOtpTest?'در حال ثبت…':'ارسال تست OTP'}</button></div></form></section></div>}
  </section>;
}
