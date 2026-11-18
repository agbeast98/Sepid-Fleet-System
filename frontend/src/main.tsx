import { Fragment, lazy, Suspense, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, errorMessage } from './api';
import { Icon, Shell, type Section } from './shell';
import { PersianDateInput } from './persian-date';
import '../legacy/assets/css/style.css';
import './style.css';

const Maintenance = lazy(() => import('./maintenance').then(module => ({ default: module.Maintenance })));
const Parts = lazy(() => import('./maintenance').then(module => ({ default: module.Parts })));
const Dashboard = lazy(() => import('./dashboard').then(module => ({ default: module.Dashboard })));
const Users = lazy(() => import('./users').then(module => ({ default: module.Users })));
const Analyses = lazy(() => import('./analyses').then(module => ({ default: module.Analyses })));
const Settings = lazy(() => import('./settings').then(module => ({ default: module.Settings })));
const Reports = lazy(() => import('./reports').then(module => ({ default: module.Reports })));
const Sms = lazy(() => import('./sms').then(module => ({ default: module.Sms })));
const Status = lazy(() => import('./status').then(module => ({ default: module.Status })));
const LegacyMigration = lazy(() => import('./legacy-migration').then(module => ({ default: module.LegacyMigration })));
const Backups = lazy(() => import('./backups').then(module => ({ default: module.Backups })));
const Guide = lazy(() => import('./guide').then(module => ({ default: module.Guide })));
const People = lazy(() => import('./people').then(module => ({ default: module.People })));
const ManagementActions = lazy(() => import('./actions').then(module => ({ default: module.ManagementActions })));

type MachineDraft = {
  code: string;
  plate: string;
  type: string;
  unit: 'km' | 'hour';
  note: string;
  active: boolean;
  floating_driver: boolean;
  model_id: string | null;
  driver_id: string | null;
  supervisor_id: string | null;
  pm_id: string | null;
};
type Machine = MachineDraft & { id: string; version: number };
type MachineCardRepair = { id:string; number:string; machine_id:string; title:string; stage:string; urgency:string; result:string|null; expected_date:string|null; refer_date:string|null; report_date:string; current_stage_since:string|null; updated_at:string };
type MachineCardAnalysis = { id:string; machine_id:string; machine_code:string; analysis_date:string; created_at:string; topic:string; severity:string; cause:string; note:string; responses:Record<string,unknown> };
type MachineAnalysisOptions = { rules:Record<'driver'|'pm',Record<'low'|'mid'|'high',{min:number;max:number|null;action:string}[]>>; countWindow:'all'|'year'|'12m' };
type MachineMaintenance = { machines:{id:string;reading:number|null;reading_date:string|null}[]; parts:{machine_id:string;state:'na'|'none'|'over'|'soon'|'ok'|string}[] };
type Account = { id: string; name: string; is_super_admin: boolean; scope_shop:boolean; permissions: Record<string, number>; stages:string[] };
type Option = { id: string; name: string; version: number };
type ModelOption = Option & { brand: string };
type PersonOption = Option & { role: string; phone?: string; note?: string; active: boolean; version?: number };
type Options = { models: ModelOption[]; people: PersonOption[] };
type BrandSettings = { companyName: string; orgName: string; theme: 'auto' | 'light' | 'dark' };
const emptyMachine: MachineDraft = {
  code: '', plate: '', type: '', unit: 'km', note: '', active: true,
  model_id: null, driver_id: null, supervisor_id: null, pm_id: null, floating_driver: false,
};
const assignments = [
  ['model_id', 'مدل ماشین', 'model'],
  ['driver_id', 'راننده', 'driver'],
  ['supervisor_id', 'سرپرست', 'supervisor'],
  ['pm_id', 'مسئول نگهداری', 'pm'],
] as const;

function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [companyName, setCompanyName] = useState('شرکت دام و طیور سپید بستک');
  const [orgName, setOrgName] = useState('واحد ماشین‌آلات');
  const [themeSetting, setThemeSetting] = useState<BrandSettings['theme']>('auto');
  const [quickAction, setQuickAction] = useState<'repairs'|'analyses'|null>(null);
  const [quickRepairId,setQuickRepairId]=useState<string|null>(null);
  const [quickRepairMachineId,setQuickRepairMachineId]=useState<string|null>(null);
  const [openRepairId,setOpenRepairId]=useState<string|null>(null);
  const [openMachineId,setOpenMachineId]=useState<string|null>(null);
  const [quickStageRequest,setQuickStageRequest]=useState(0);
  const [openPartId,setOpenPartId]=useState<string|null>(null);
  const [ready, setReady] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [otpAvailable,setOtpAvailable]=useState(false);
  const [otpStep,setOtpStep]=useState(false);
  const [otpPhone,setOtpPhone]=useState('');
  const [section, setSection] = useState<Section>(() =>
    new URLSearchParams(window.location.search).get('section') === 'sms' ? 'sms' : 'dashboard',
  );
  const [actionPersonId, setActionPersonId] = useState<string|null>(null);

  useEffect(() => {
    api<BrandSettings>('/settings/brand').then(value => { setCompanyName(value.companyName); setOrgName(value.orgName); setThemeSetting(value.theme); }).catch(() => {});
    api<{enabled:boolean}>('/auth/otp-status').then(value=>setOtpAvailable(value.enabled)).catch(()=>{});
  }, []);

  useEffect(() => {
    api<Account>('/auth/me').then(setAccount).catch(async (failure: unknown) => {
      if (failure instanceof ApiError && failure.status === 401) {
        try { setSetupRequired((await api<{ required: boolean }>('/auth/setup-status')).required); }
        catch (statusFailure) { setError(errorMessage(statusFailure)); }
      } else setError(errorMessage(failure));
    }).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!account) return;
    if (section === 'sms' && (account.permissions.sms ?? 0) < 2) {
      setSection('dashboard');
      return;
    }
    if (account.permissions.dashboard || section !== 'dashboard') return;
    const firstAllowed: Section | undefined = account.permissions.status ? 'status' : account.permissions.repairs ? 'repairs' : account.permissions.machines ? 'machines'
      : account.permissions.maint ? 'maintenance' : account.permissions.parts ? 'parts' : account.permissions.analyses ? 'analyses'
        : account.permissions.people ? 'actions' : account.permissions.settings ? 'settings' : (account.permissions.sms ?? 0) >= 2 ? 'sms' : undefined;
    if (firstAllowed) setSection(firstAllowed);
  }, [account, section]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    try {
      await api('/auth/login', 'POST', {
        username: form.get('username'), password: form.get('password'), remember: form.has('remember'),
      });
      setSetupRequired(false);
      setAccount(await api<Account>('/auth/me'));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function requestOtp(phone:string){
    setPending(true);setError('');
    try{await api('/auth/otp/request','POST',{phone});setOtpPhone(phone);setOtpStep(true);setError('');}
    catch(failure){setError(errorMessage(failure));}finally{setPending(false);}
  }
  async function verifyOtp(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=new FormData(event.currentTarget);setPending(true);setError('');
    try{await api('/auth/otp/verify','POST',{phone:otpPhone,code:form.get('code'),remember:form.has('remember')});setSetupRequired(false);setAccount(await api<Account>('/auth/me'));}
    catch(failure){setError(errorMessage(failure));}finally{setPending(false);}
  }

  async function setupAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirmPassword') ?? '')) { setError('رمز عبور و تکرار آن یکسان نیستند.'); return; }
    setPending(true);
    setError('');
    try {
      await api('/auth/setup', 'POST', { username: form.get('username'), password, confirmPassword: form.get('confirmPassword') });
      setSetupRequired(false);
      setAccount(await api<Account>('/auth/me'));
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  async function logout() {
    setPending(true);
    setError('');
    try {
      await api('/auth/logout', 'POST');
      setAccount(null);
      setSetupRequired((await api<{ required: boolean }>('/auth/setup-status')).required);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  if (account) return <Shell section={section} navigate={setSection} onQuickCreate={target=>{setQuickRepairId(null);setQuickRepairMachineId(null);setQuickAction(target);setSection(target);}} onQuickStage={()=>{setSection('status');setQuickStageRequest(value=>value+1);}} name={account.name} companyName={companyName} orgName={orgName} themeSetting={themeSetting} onThemeSettingChange={setThemeSetting} isAdmin={account.is_super_admin} permissions={account.permissions} logout={logout} pending={pending}>
    {error && <p role="alert">{error}</p>}
    <Suspense fallback={<div className="panel" role="status">در حال بارگیری این بخش…</div>}>
    {section === 'dashboard' && <Dashboard permissions={account.permissions} navigate={setSection} onQuickCreate={target=>{setQuickAction(target);setSection(target);}} onOpenActionPerson={personId=>{setActionPersonId(personId);setSection('actions');}} companyName={companyName} orgName={orgName} />}
    {section === 'status' && <Status permissions={account.permissions} allowedStages={account.stages??[]} quickPickRequest={quickStageRequest} onOpenMachine={id=>{setOpenMachineId(id);setSection('machines');}} onCreateRepair={()=>{setQuickAction('repairs');setSection('repairs');}} />}
    {section === 'machines' && <Machines permissions={account.permissions} navigate={setSection} initialMachineId={openMachineId} onInitialMachineOpened={()=>setOpenMachineId(null)} onOpenRepair={id=>{setOpenRepairId(id);setSection('repairs');}} onCreateRepair={id=>{setQuickRepairMachineId(id);setQuickAction('repairs');setSection('repairs');}} />}
    {section === 'people' && <People level={account.permissions.people??0} availableSections={(['machines','people'] as const).filter(key=>(account.permissions[key]??0)>=1)} canManageDefinitions={(account.permissions.settings??0)>=2} onNavigate={setSection} />}
    {section === 'actions' && <ManagementActions permissions={account.permissions} initialPersonId={actionPersonId} onSelectPerson={setActionPersonId} onNavigate={setSection} />}
    {section === 'repairs' && <Repairs startNew={quickAction==='repairs'} initialMachineId={quickRepairMachineId} onQuickComplete={()=>{setQuickAction(null);setQuickRepairMachineId(null);}} canUndo={(account.permissions.status??0)>=3} initialRepairId={openRepairId} onInitialRepairOpened={()=>setOpenRepairId(null)} onAnalyze={(id)=>{setQuickRepairId(id);setQuickAction('analyses');setSection('analyses');}} canAnalyze={(account.permissions.analyses??0)>=2} />}
    {section === 'maintenance' && <Maintenance canEditParts={(account.permissions.parts??0)>=2} onEditPart={id=>{setOpenPartId(id);setSection('parts');}} />}
    {section === 'parts' && <Parts initialPartId={openPartId} onInitialPartOpened={()=>setOpenPartId(null)} />}
    {section === 'users' && <Users />}
    {section === 'analyses' && <Analyses startNew={quickAction==='analyses'} onQuickComplete={()=>{setQuickAction(null);setQuickRepairId(null);}} quickRepairId={quickRepairId} onOpenRepair={id=>{setOpenRepairId(id);setSection('repairs');}} canEdit={(account.permissions.analyses??0)>=2} />}
    {section === 'settings' && <Settings availableSections={(['machines','people','maintenance','parts','sms'] as const).filter(key => (account.permissions[key==='maintenance'?'maint':key]??0)>=(key==='sms'?2:1))} canManageDefinitions={(account.permissions.settings??0)>=2} onNavigate={setSection} onSettingsChange={value => { setCompanyName(value.companyName); setOrgName(value.orgName); setThemeSetting(value.theme); }} />}
    {(section === 'reports' || section === 'archive') && <Reports key={section} initialArchive={section === 'archive' ? 'closed' : 'all'} onOpenRepair={id=>{setOpenRepairId(id);setSection('repairs');}} />}
    {section === 'sms' && (account.permissions.sms ?? 0) >= 2 && <Sms />}
    {section === 'migration' && account.is_super_admin && <LegacyMigration />}
    {section === 'backups' && account.is_super_admin && <Backups />}
    {section === 'guide' && <Guide />}
    </Suspense>
  </Shell>;
  return <div id="authView"><main className="auth">
    <div className="auth-side">
      <div className="auth-brand">
        <div className="brand-mark"><Icon name="truck" /></div>
        <div className="brand-text"><b>سامانه ناوگان</b><span className="co">{companyName}</span></div>
      </div>
      <div className="auth-pitch">
        <b>وضعیت هر ماشین، بدون تلفن</b>
        <span>سرپرست، تعمیرات و مدیریت همه یک تصویر را می‌بینند. هر تغییر مرحله با نام ثبت‌کننده و ساعت ذخیره می‌شود و برای سرپرست پیامک می‌رود.</span>
      </div>
      <small>{orgName}</small>
    </div>
    <div className="auth-main">
      {!ready ? <p role="status">در حال بارگذاری…</p> : setupRequired ? <form className="auth-form" onSubmit={setupAdmin}>
        <div className="auth-head"><span className="auth-ic"><Icon name="shield-check" /></span>
          <h1>راه‌اندازی اولیه</h1>
          <p>کاربر مدیر کل سامانه <b>آرمین جمالی</b> است و دسترسی کامل دارد. یک نام کاربری و رمز برای او تعیین کنید؛ بعد از ورود، او برای بقیه کاربر می‌سازد و دسترسی می‌دهد.</p>
        </div>
        <label className="field"><span className="field-label">نام کاربری مدیر کل</span>
          <span className="input-ic"><Icon name="user" /><input className="input" name="username" dir="ltr" required minLength={3} maxLength={100} pattern="[A-Za-z0-9._-]+" defaultValue="armin" autoComplete="username" autoFocus /></span>
        </label>
        <label className="field"><span className="field-label">رمز عبور</span>
          <span className="input-ic"><Icon name="lock" /><input className="input" name="password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" placeholder="دست‌کم ۱۲ نویسه" /></span>
        </label>
        <label className="field"><span className="field-label">تکرار رمز عبور</span>
          <span className="input-ic"><Icon name="lock" /><input className="input" name="confirmPassword" type="password" required minLength={12} maxLength={256} autoComplete="new-password" /></span>
        </label>
        <button className="btn btn-primary btn-lg" type="submit" disabled={pending}><Icon name="check" />ذخیره و ورود</button>
        <div className="auth-err" role="alert">{error}</div>
      </form> : <form className="auth-form auth-sign-in" onSubmit={otpStep?verifyOtp:login}>
        <div className="auth-head">
          <h1>ورود به سامانه</h1>
          <p>{otpStep?`اگر این شماره حساب فعال داشته باشد، کد تأیید برای ${otpPhone} درخواست شده است.`:'شماره موبایل و رمز عبور را وارد کنید.'}</p>
        </div>
        {!otpStep&&<><label className="field"><span className="field-label">شماره موبایل</span>
          <span className="input-ic"><Icon name="user" /><input className="input" name="username" dir="ltr" required autoComplete="username" maxLength={100} autoFocus /></span>
        </label>
        <label className="field"><span className="field-label">رمز عبور</span>
          <span className="input-ic"><Icon name="lock" /><input className="input" name="password" type="password" dir="ltr" required autoComplete="current-password" maxLength={256} /></span>
        </label></>}
        {otpStep&&<label className="field"><span className="field-label">کد تأیید شش‌رقمی</span><span className="input-ic"><Icon name="lock" /><input className="input" name="code" inputMode="numeric" dir="ltr" required pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" autoFocus /></span></label>}
        <label className="check"><input name="remember" type="checkbox" /><span>این دستگاه را به خاطر بسپار</span></label>
        <button className="btn btn-primary btn-lg" type="submit" disabled={pending}><Icon name="log-out" />{otpStep?'تأیید و ورود':'ورود'}</button>
        {!otpStep&&<button className="btn btn-ghost btn-lg" type="button" disabled={!otpAvailable||pending} onClick={event=>{const form=event.currentTarget.form;if(!form)return;const phone=String(new FormData(form).get('username')??'');if(!phone.trim()){setError('ابتدا شماره موبایل را وارد کنید.');return;}void requestOtp(phone);}}>{otpAvailable?'ورود با کد تأیید':'ورود با کد تأیید (نیازمند تنظیم قالب ورود در پنل پیامک)'}</button>}
        {otpStep&&<button className="btn btn-ghost" type="button" onClick={()=>{setOtpStep(false);setOtpPhone('');setError('');}}>بازگشت به ورود با رمز</button>}
        {!otpStep&&<div className="auth-note">رمز را فراموش کرده‌اید؟ از مدیر سامانه بخواهید برایتان رمز جدید تعیین کند. پس از ۵ بار رمز اشتباه، حساب ۱۵ دقیقه قفل می‌شود.</div>}
        <div className="auth-err" role="alert">{error}</div>
      </form>}
    </div>
  </main></div>;
}

type MachineProfileData = {
  repairEvents: {id:string;repair_id:string;revision:number;stage_label:string;stage:string;result:string|null;note:string;details?:Record<string,string>;voided_at?:string|null;recorded_at:string;number:string;title:string;shop:string;actor_name:string}[];
  analyses: {id:string;topic:string;analysis_date:string;severity:string;cause:string;note:string;responses:Record<string,unknown>}[];
  readings: {id:string;reading:string|null;recorded_on:string;unit:string;note:string}[];
  services: {id:string;name:string;kind:string;recorded_on:string;reading:string|null;note:string}[];
};

type MachineTimelineItem={id:string;kind:'repair'|'test'|'analysis'|'reading'|'service';date:string;title:string;detail:string;repairId?:string};

function Machines({permissions,navigate,initialMachineId,onInitialMachineOpened,onOpenRepair,onCreateRepair}:{permissions:Record<string,number>;navigate:(section:Section)=>void;initialMachineId:string|null;onInitialMachineOpened:()=>void;onOpenRepair:(id:string)=>void;onCreateRepair:(machineId:string)=>void}) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [options, setOptions] = useState<Options>({ models: [], people: [] });
  const [cardRepairs,setCardRepairs]=useState<MachineCardRepair[]>([]);
  const [cardStages,setCardStages]=useState<RepairStageDefinition[]>(repairStages);
  const [cardAnalyses,setCardAnalyses]=useState<MachineCardAnalysis[]>([]);
  const [cardAnalysisOptions,setCardAnalysisOptions]=useState<MachineAnalysisOptions|null>(null);
  const [cardMaintenance,setCardMaintenance]=useState<MachineMaintenance>({machines:[],parts:[]});
  const [directory, setDirectory] = useState<'model' | 'person' | null>(null);
  const [directoryEditing, setDirectoryEditing] = useState<ModelOption | PersonOption | null>(null);
  const [editing, setEditing] = useState<Machine | null>(null);
  const [draft, setDraft] = useState<MachineDraft>(emptyMachine);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [profile,setProfile]=useState<Machine|null>(null);
  const [profileData,setProfileData]=useState<MachineProfileData|null>(null);
  const [profilePending,setProfilePending]=useState(false);
  const [historyKind,setHistoryKind]=useState<'all'|'repair'|'test'|'analysis'|'reading'|'service'>('all');
  const [showAllHistory,setShowAllHistory]=useState(false);

  async function refresh() {
    setBusy(true);
    setError('');
    try {
      const [list, lookups] = await Promise.all([api<Machine[]>('/machines'), api<Options>('/machines/options')]);
      if ((permissions.people ?? 0) >= 1) {
        const people = await api<PersonOption[]>('/people');
        lookups.people = people;
      }
      setMachines(list);
      setOptions(lookups);
      const optional = await Promise.allSettled([
        (permissions.repairs??0)>=1 ? api<MachineCardRepair[]>('/repairs') : Promise.resolve([] as MachineCardRepair[]),
        (permissions.repairs??0)>=1 ? api<RepairStageDefinition[]>('/repairs/stages') : Promise.resolve(repairStages),
        (permissions.analyses??0)>=1 ? api<MachineCardAnalysis[]>('/analyses') : Promise.resolve([] as MachineCardAnalysis[]),
        (permissions.maint??0)>=1 ? api<MachineMaintenance>('/maintenance') : Promise.resolve({machines:[],parts:[]} as MachineMaintenance),
        (permissions.analyses??0)>=1 ? api<MachineAnalysisOptions>('/analyses/options') : Promise.resolve(null),
      ]);
      setCardRepairs(optional[0].status==='fulfilled'?optional[0].value:[]);
      setCardStages(optional[1].status==='fulfilled'?optional[1].value:repairStages);
      setCardAnalyses(optional[2].status==='fulfilled'?optional[2].value:[]);
      setCardMaintenance(optional[3].status==='fulfilled'?optional[3].value:{machines:[],parts:[]});
      setCardAnalysisOptions(optional[4].status==='fulfilled'?optional[4].value:null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (sessionStorage.getItem('sepid-directory-focus') !== 'model') return;
    sessionStorage.removeItem('sepid-directory-focus');
    requestAnimationFrame(() => {
      const panel = document.getElementById('machine-directory-management');
      if (panel instanceof HTMLDetailsElement) panel.open = true;
      document.getElementById('models-directory')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  async function showProfile(machine:Machine) {
    setProfile(machine);setProfileData(null);setProfilePending(true);setError('');setHistoryKind('all');setShowAllHistory(false);
    const tasks:Promise<Partial<MachineProfileData>>[]=[];
    if((permissions.repairs??0)>=1)tasks.push(api<MachineProfileData['repairEvents']>(`/repairs/machines/${encodeURIComponent(machine.id)}/history`).then(repairEvents=>({repairEvents})));
    if((permissions.analyses??0)>=1)tasks.push(api<{id:string;machine_id:string;topic:string;analysis_date:string;severity:string;cause:string;note:string;responses:Record<string,unknown>}[]>('/analyses').then(rows=>({analyses:rows.filter(item=>item.machine_id===machine.id)})));
    if((permissions.maint??0)>=1)tasks.push(api<{readings:MachineProfileData['readings'];services:MachineProfileData['services']}>(`/maintenance/${encodeURIComponent(machine.id)}/history`).then(history=>history));
    const results=await Promise.allSettled(tasks);
    const data:MachineProfileData={repairEvents:[],analyses:[],readings:[],services:[]};let failed=false;
    for(const result of results)if(result.status==='fulfilled')Object.assign(data,result.value);else failed=true;
    setProfileData(data);setProfilePending(false);
    if(failed)setError('بخشی از سابقهٔ ماشین بارگیری نشد. دسترسی بخش مربوط را بررسی کنید.');
  }

  useEffect(()=>{
    if(!initialMachineId)return;
    const machine=machines.find(item=>item.id===initialMachineId);
    if(!machine)return;
    void showProfile(machine);
    onInitialMachineOpened();
  },[initialMachineId,machines]);

  function open(machine: Machine | null) {
    setDirectory(null);
    setEditing(machine);
    setDraft(machine ?? emptyMachine);
    setStatus('');
    setShowForm(true);
  }

  async function saveDirectory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!directory) return;
    const form = new FormData(event.currentTarget);
    const fields: Record<string, unknown> = Object.fromEntries(form);
    if (directoryEditing && directory === 'person') fields.active = form.has('active');
    setBusy(true);
    setError('');
    setStatus('');
    try {
      if (directoryEditing) await api(`${directory === 'model' ? '/models/' : '/people/'}${encodeURIComponent(directoryEditing.id)}`, 'PATCH', { ...fields, version: directoryEditing.version });
      else await api(directory === 'model' ? '/models' : '/people', 'POST', fields);
      setDirectory(null);
      setDirectoryEditing(null);
      setStatus('اطلاعات پایه ذخیره شد.');
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function deleteModel(model: ModelOption) {
    if (machines.some(machine => machine.model_id === model.id)) {
      setError('این مدل به ماشین اختصاص دارد و قابل حذف نیست. ابتدا مدل ماشین را تغییر دهید.');
      return;
    }
    if (!window.confirm(`مدل «${model.name}» و فهرست قطعات آن حذف شود؟ سوابق سرویس قبلی حفظ می‌شوند.`)) return;
    setBusy(true); setError(''); setStatus('');
    try {
      await api(`/models/${encodeURIComponent(model.id)}`, 'DELETE');
      setStatus('مدل و فهرست قطعاتش حذف شد؛ سوابق ثبت‌شدهٔ سرویس محفوظ است.');
      await refresh();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  function openDirectory(kind: 'model' | 'person', item: ModelOption | PersonOption | null = null) {
    setShowForm(false);
    setError('');
    setStatus('');
    setDirectory(kind);
    setDirectoryEditing(item);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const saved = editing
        ? await api<Machine>('/machines/' + encodeURIComponent(editing.id), 'PATCH', { ...draft, version: editing.version })
        : await api<Machine>('/machines', 'POST', draft);
      setMachines(items => editing
        ? items.map(item => item.id === saved.id ? saved : item)
        : [...items, saved]);
      setProfile(current => current?.id === saved.id ? saved : current);
      setShowForm(false);
      setStatus('پرونده ذخیره شد.');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  const faNumber=(value:number)=>new Intl.NumberFormat('fa-IR').format(value);
  const today=todayTehran();
  const cardIsLate=(repair:MachineCardRepair)=>{
    if(repair.expected_date&&repair.expected_date<today)return true;
    const stage=cardStages.find(item=>item.id===repair.stage);
    if(stage?.limit&&repair.current_stage_since&&Date.now()-Date.parse(repair.current_stage_since)>stage.limit*86400000)return true;
    const referralLimit=repair.urgency==='urgent'?0:repair.urgency==='d13'?3:repair.urgency==='d47'?7:null;
    if(repair.stage==='report'&&!repair.refer_date&&referralLimit!==null){
      const days=Math.floor((Date.parse(`${today}T00:00:00Z`)-Date.parse(`${repair.report_date}T00:00:00Z`))/86400000);
      if(days>referralLimit)return true;
    }
    return false;
  };
  const plateContent=(plate:string)=>{
    if(!plate.trim())return <span className="muted small">بدون پلاک</span>;
    const match=/^(\d+)(\D+)(\d+)$/.exec(plate);
    return <span className="plate" title="پلاک"><span className="plate-flag"/><span className="plate-main">{match?<>{match[1]}<i>{match[2]}</i>{match[3]}</>:plate}</span></span>;
  };
  const profileActivity:MachineTimelineItem[]=profileData?[
    ...profileData.repairEvents.map(item=>({id:`repair-${item.id}`,kind:item.stage==='test'?'test' as const:'repair' as const,repairId:item.repair_id,date:item.recorded_at,title:`پروندهٔ ${item.number} · ${item.title} · ${item.stage_label}${item.voided_at?' · لغوشده':''}`,detail:[item.shop,item.details?.part_name,item.details?.part_status,item.details?.part_vendor,item.details?.part_eta?`تحویل ${item.details.part_eta}`:'',item.actor_name,item.note].filter(Boolean).join(' · ')})),
    ...profileData.analyses.map(item=>{
      const driver=item.responses.q1==='yes'&&item.responses.q1b==='no';
      const pm=item.responses.q2==='yes'&&item.responses.q2b==='no';
      const result=driver&&pm?'سهل‌انگاری مشترک':driver?'سهل‌انگاری راننده':pm?'سهل‌انگاری مسئول PM':'بدون سهل‌انگاری';
      const severity:Record<string,string>={low:'کم‌اهمیت',medium:'نیمه‌حساس',high:'خیلی حساس'};
      return {id:`analysis-${item.id}`,kind:'analysis' as const,date:item.analysis_date,title:`تحلیل خرابی · ${item.topic}`,detail:[result,`حساسیت ${severity[item.severity]??item.severity}`,item.cause?`علت احتمالی: ${item.cause}`:'',item.note].filter(Boolean).join(' · ')};
    }),
    ...profileData.readings.map(item=>({id:`reading-${item.id}`,kind:'reading' as const,date:item.recorded_on,title:`ثبت کارکرد · ${item.reading??'—'} ${item.unit==='hour'?'ساعت':'کیلومتر'}`,detail:item.note})),
    ...profileData.services.map(item=>({id:`service-${item.id}`,kind:'service' as const,date:item.recorded_on,title:`${item.kind==='replacement'?'تعویض':'سرویس'} · ${item.name}${item.reading?` · ${item.reading}`:''}`,detail:item.note})),
  ].sort((a,b)=>b.date.localeCompare(a.date)):[];
  const filteredProfileActivity=profileActivity.filter(item=>historyKind==='all'||item.kind===historyKind);
  const timelineKindCounts: [typeof historyKind,string,number][]=[['all','همه',profileActivity.length],['repair','خرابی و تعمیر',profileActivity.filter(item=>item.kind==='repair').length],['test','تست سلامت',profileActivity.filter(item=>item.kind==='test').length],['analysis','تحلیل خرابی',profileActivity.filter(item=>item.kind==='analysis').length],['service','نگهداری و تعویض قطعه',profileActivity.filter(item=>item.kind==='service').length],['reading','کارکرد',profileActivity.filter(item=>item.kind==='reading').length]];
  const timelineKinds=timelineKindCounts.filter(([kind,,count])=>kind==='all'||count>0);
  const visibleProfileActivity=showAllHistory?filteredProfileActivity:filteredProfileActivity.slice(0,30);
  const profileRepairs=profile?cardRepairs.filter(item=>item.machine_id===profile.id).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)):[];
  const profileOpenRepairs=profileRepairs.filter(item=>item.result===null);
  const profileReading=profileData?.readings.slice().sort((a,b)=>b.recorded_on.localeCompare(a.recorded_on))[0];
  const profileMaintenance=profile?cardMaintenance.machines.find(item=>item.id===profile.id):undefined;
  const profileParts=profile?cardMaintenance.parts.filter(item=>item.machine_id===profile.id):[];
  const profileActionRows=(role:'driver'|'pm')=>{
    const personId=role==='driver'?profile?.driver_id:profile?.pm_id;
    const personName=role==='driver'?options.people.find(item=>item.id===personId)?.name:options.people.find(item=>item.id===personId)?.name;
    const responseId=role==='driver'?'driver_id':'pm_id';
    const responseName=role==='driver'?'driver_name':'pm_name';
    const negligent=(item:MachineCardAnalysis)=>role==='driver'
      ?item.responses.q1==='yes'&&item.responses.q1b==='no'
      :item.responses.q2==='yes'&&item.responses.q2b==='no';
    const normalized=(value:unknown)=>typeof value==='string'?value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('fa'):'';
    const related=cardAnalyses.filter(item=>{
      if(!negligent(item))return false;
      const assigned=item.responses[responseId];
      return personId?assigned===personId||(!assigned&&!!personName&&normalized(item.responses[responseName])===normalized(personName)):false;
    });
    const currentDate=new Date(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())+'T12:00:00Z');
    const inWindow=(date:string)=>{
      if((cardAnalysisOptions?.countWindow??'all')==='all')return true;
      const value=new Date(date.slice(0,10)+'T12:00:00Z');
      if(Number.isNaN(value.valueOf())||value>currentDate)return false;
      if(cardAnalysisOptions?.countWindow==='year')return new Intl.DateTimeFormat('en-US-u-ca-persian',{year:'numeric',timeZone:'UTC'}).format(value)===new Intl.DateTimeFormat('en-US-u-ca-persian',{year:'numeric',timeZone:'UTC'}).format(currentDate);
      return currentDate.valueOf()-value.valueOf()<=365*86400000;
    };
    return (['low','mid','high'] as const).map(severity=>{
      const count=related.filter(item=>(item.severity==='medium'?'mid':item.severity)===severity&&inWindow(item.analysis_date)).length;
      const action=(cardAnalysisOptions?.rules?.[role]?.[severity]??[]).find(rule=>count>=rule.min&&(rule.max===null||count<=rule.max))?.action??'';
      return {severity,count,action};
    });
  };
  const activityMonth=(date:string)=>{
    const normalized=date.slice(0,10);
    const value=new Date(`${normalized}T12:00:00Z`);
    return Number.isNaN(value.valueOf())?'تاریخ نامشخص':new Intl.DateTimeFormat('fa-IR',{month:'long',year:'numeric',timeZone:'Asia/Tehran'}).format(value);
  };
  function printMachineHistory(){
    if(!profile)return;
    const popup=window.open('','_blank');if(!popup){setError('پنجرهٔ چاپ باز نشد؛ اجازهٔ بازشدن پنجره را در مرورگر فعال کنید.');return;}
    const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]??char));
    const kindLabel=new Map<string,string>(timelineKinds.map(([kind,label])=>[kind,label]));
    const rows=filteredProfileActivity.map((item,index)=>`<tr><td>${faNumber(index+1)}</td><td>${escape(new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium',timeZone:'Asia/Tehran'}).format(new Date(item.date.length===10?item.date+'T12:00:00':item.date)))}</td><td>${escape(kindLabel.get(item.kind))}</td><td>${escape(item.title)}</td><td>${escape(item.detail||'—')}</td></tr>`).join('');
    popup.document.open();popup.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>تاریخچهٔ ماشین ${escape(profile.code)}</title><style>@page{size:A4 landscape;margin:14mm}body{font:11px Tahoma,Arial,sans-serif;color:#172126}header{display:flex;justify-content:space-between;border-bottom:2px solid #174e5a;padding-bottom:10px;margin-bottom:14px}h1{font-size:19px;color:#174e5a;margin:0 0 5px}.muted{color:#69767a}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccd4d6;padding:7px;text-align:right;vertical-align:top}th{background:#edf2f3}tbody tr:nth-child(even){background:#f8faf9}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:34px;text-align:center}.signatures div{border-top:1px solid #66777b;padding-top:7px}</style></head><body><header><div><h1>تاریخچهٔ ماشین ${escape(profile.code)}</h1><span class="muted">${escape(kindLabel.get(historyKind))} · ${faNumber(rows?filteredProfileActivity.length:0)} رویداد</span></div><span class="muted">${escape(options.models.find(model=>model.id===profile.model_id)?.name??'')}</span></header><table><thead><tr><th>ردیف</th><th>تاریخ</th><th>نوع</th><th>شرح</th><th>جزئیات</th></tr></thead><tbody>${rows||'<tr><td colspan="5">سابقه‌ای برای چاپ وجود ندارد.</td></tr>'}</tbody></table><section class="signatures"><div>مسئول ماشین‌آلات</div><div>سرپرست</div><div>مدیریت</div></section><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`);popup.document.close();
  }

  return <section className="page">
    {profile?<header className="page-head machine-profile-head"><div className="ph-text"><button type="button" className="link machine-profile-breadcrumb" onClick={()=>{setProfile(null);setProfileData(null);}}>پرونده ماشین‌ها</button><h1>{profile.code}</h1><p>{profile.type||'نوع ثبت نشده'} · {options.models.find(model=>model.id===profile.model_id)?.name??'مدل ثبت نشده'}</p></div><div className="ph-actions">
      {(permissions.repairs??0)>=2&&<button className="btn btn-primary" type="button" onClick={()=>onCreateRepair(profile.id)}><Icon name="triangle-alert"/> اعلام خرابی</button>}
      <button className="btn btn-ghost" type="button" onClick={()=>document.getElementById('machine-full-history')?.scrollIntoView({behavior:'smooth',block:'start'})}><Icon name="history"/> تاریخچه کامل</button>
      {(permissions.machines??0)>=2&&<button className="btn btn-ghost" type="button" onClick={()=>open(profile)}><Icon name="pencil"/> ویرایش مشخصات</button>}
      {(permissions.maint??0)>=1&&<button className="btn btn-ghost" type="button" onClick={()=>navigate('maintenance')}><Icon name="gauge"/> نگهداری پیشگیرانه</button>}
    </div></header>:<header className="page-head"><div className="ph-text"><h1>پرونده ماشین‌ها</h1><p>{new Intl.NumberFormat('fa-IR').format(machines.length)} ماشین در ناوگان · روی هر ماشین بزنید تا تاریخچهٔ کامل آن را ببینید</p></div><div className="ph-actions">
      <button className="btn btn-ghost" disabled={busy} onClick={()=>{const panel=document.getElementById('machine-directory-management');if(panel instanceof HTMLDetailsElement){panel.open=!panel.open;if(panel.open)panel.scrollIntoView({behavior:'smooth',block:'start'});}}}><Icon name="settings"/> تعریف و ویرایش ماشین‌ها</button>
    </div></header>}
    <div className="machine-page-content">
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {profile&&<article className="machine-profile machine-profile-legacy" aria-label={`پروندهٔ ماشین ${profile.code}`}>
      <dl className="machine-profile-specs legacy-specs">
        <div><dt>نوع دستگاه</dt><dd>{profile.type||'—'}</dd></div>
        <div><dt>پلاک</dt><dd>{plateContent(profile.plate)}</dd></div>
        <div><dt>مدل</dt><dd>{options.models.find(model=>model.id===profile.model_id)?.name??'مدل ثبت نشده'}</dd></div>
        <div><dt>نام راننده</dt><dd>{profile.floating_driver?'متغیر':options.people.find(person=>person.id===profile.driver_id)?.name??'—'}</dd></div>
        <div><dt>نام سرپرست</dt><dd>{options.people.find(person=>person.id===profile.supervisor_id)?.name??'—'}</dd></div>
        <div><dt>نام مسئول PM</dt><dd>{options.people.find(person=>person.id===profile.pm_id)?.name??'—'}</dd></div>
      </dl>
      {(permissions.analyses??0)>=1&&<div className="machine-management-actions">{(['driver','pm'] as const).map(role=>{
        const rows=profileActionRows(role);const person=options.people.find(item=>item.id===(role==='driver'?profile.driver_id:profile.pm_id));
        return <section className="machine-profile-list" key={role}><h3>لیست اقدامات مدیریتی {role==='driver'?'راننده':'مسئول PM'}{person&&<button type="button" className="link" onClick={()=>navigate('actions')}>{person.name}</button>}</h3><div className="table-wrap"><table><thead><tr><th>نتیجه بررسی</th><th>سطح حساسیت</th><th>تعداد دفعات</th><th>اقدامات مدیریتی</th></tr></thead><tbody>{rows.map(row=><tr key={row.severity}><td>{row.count?role==='driver'?'سهل‌انگاری راننده':'سهل‌انگاری مسئول PM':'—'}</td><td><span className={`sev sev-${row.severity}`}><i/>{row.severity==='low'?'کم اهمیت':row.severity==='mid'?'نیمه حساس':'خیلی حساس'}</span></td><td>{faNumber(row.count)}</td><td>{row.action||'—'}</td></tr>)}</tbody></table></div></section>;
      })}</div>}
      {profilePending&&<p role="status">در حال دریافت تاریخچهٔ ماشین…</p>}
      {profileData&&(permissions.repairs??0)>=1&&<section className="machine-profile-list machine-profile-repairs"><div className="machine-timeline-head"><h3>خرابی‌ها و تعمیرات این ماشین</h3><button type="button" className="btn btn-primary" onClick={()=>onCreateRepair(profile.id)}>اعلام خرابی</button></div>
          {profileRepairs.length?<div className="table-wrap"><table><thead><tr><th>شماره</th><th>شرح</th><th>مرحله</th><th>فوریت</th><th>آخرین تغییر</th><th></th></tr></thead><tbody>{profileRepairs.slice(0,8).map(item=><tr key={item.id}><td>{item.number}</td><td>{item.title}</td><td>{cardStages.find(stage=>stage.id===item.stage)?.label??item.stage}</td><td>{item.urgency==='urgent'?'فوری':item.urgency==='d13'?'۱ تا ۳ روز':item.urgency==='d47'?'۴ تا ۷ روز':'عادی'}</td><td>{item.updated_at.slice(0,10)}</td><td><button type="button" className="link" onClick={()=>onOpenRepair(item.id)}>بازکردن</button></td></tr>)}</tbody></table></div>:<p className="calm">خرابی‌ای برای این ماشین ثبت نشده</p>}
      </section>}
      {(profileData||profilePending)&&<div className="machine-profile-lower-grid">
        {profileData&&(permissions.analyses??0)>=1&&<section className="machine-profile-list machine-profile-analysis"><div className="machine-timeline-head"><h3>تحلیل‌های خرابی این ماشین</h3><button type="button" className="btn btn-primary" onClick={()=>navigate('analyses')}>تحلیل جدید</button></div>
          {profileData.analyses.length?<ul className="mini-list">{profileData.analyses.map(item=><li key={item.id}><b>{item.topic}</b><span>{item.analysis_date} · {item.severity}</span></li>)}</ul>:<p className="calm">تحلیلی برای این خودرو ثبت نشده</p>}
        </section>}
      <div className="machine-profile-legacy-status">
        {(permissions.maint??0)>=1&&<section className="machine-profile-list"><div className="machine-timeline-head"><h3>کارکرد فعلی</h3><button type="button" onClick={()=>navigate('maintenance')}>به‌روزرسانی</button></div><strong>{profileReading?.reading??profileMaintenance?.reading??'—'} <span>{profile.unit==='hour'?'ساعت':'کیلومتر'}</span></strong><p>{profileReading?.recorded_on??profileMaintenance?.reading_date??'هنوز ثبت نشده'}</p></section>}
        {(permissions.parts??0)>=1&&<section className="machine-profile-list"><div className="machine-timeline-head"><h3>وضعیت قطعات</h3><button type="button" onClick={()=>navigate('parts')}>‹</button></div><div className="machine-parts-summary">{(['over','soon','ok','none'] as const).map(state=><div key={state} data-state={state}><b>{faNumber(profileParts.filter(item=>item.state===state).length)}</b><span>{state==='over'?'گذشته از موعد':state==='soon'?'نزدیک موعد':state==='ok'?'سالم':'ثبت نشده'}</span></div>)}</div></section>}
      </div></div>}
      {profileData&&<div className="machine-profile-history">
        <section id="machine-full-history" className="machine-timeline"><div className="machine-timeline-head"><div><h4>تاریخچه کامل ماشین (بایگانی)</h4><small>هر چیزی که برای این ماشین ثبت شود اینجا می‌ماند</small></div><button type="button" onClick={printMachineHistory}>چاپ</button></div>
          <div className="machine-history-filters">{timelineKinds.map(([kind,label,count])=><button type="button" key={kind} aria-pressed={historyKind===kind} className={historyKind===kind?'active':''} onClick={()=>{setHistoryKind(kind);setShowAllHistory(false);}}>{label} <span>{faNumber(count)}</span></button>)}</div>
          {filteredProfileActivity.length?<><ol>{visibleProfileActivity.map((item,index)=><Fragment key={item.id}>{(index===0||activityMonth(visibleProfileActivity[index-1].date)!==activityMonth(item.date))&&<li className="machine-history-month">{activityMonth(item.date)}</li>}<li><time>{new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium',timeZone:'Asia/Tehran'}).format(new Date(item.date.length===10?item.date+'T12:00:00':item.date))}</time><div><b>{item.title}</b>{item.detail&&<small>{item.detail}</small>}</div>{item.repairId&&(permissions.repairs??0)>=1&&<button type="button" className="link" onClick={()=>onOpenRepair(item.repairId!)}>بازکردن پرونده</button>}</li></Fragment>)}</ol>{filteredProfileActivity.length>30&&!showAllHistory&&<button className="machine-history-more" type="button" onClick={()=>setShowAllHistory(true)}>نمایش {faNumber(filteredProfileActivity.length-30)} رویداد دیگر</button>}</>:<p>{historyKind==='all'&&!profileActivity.length?'هنوز چیزی برای این ماشین ثبت نشده':'برای این ماشین در این دسته سابقه‌ای ثبت نشده است.'}</p>}
        </section>
      </div>}
    </article>}
    {!profile&&directory && <form key={directory + (directoryEditing?.id ?? 'new')} onSubmit={saveDirectory}>
      <h3>{directoryEditing ? `ویرایش ${directory === 'model' ? 'مدل' : 'پرسنل'}` : directory === 'model' ? 'مدل جدید' : 'پرسنل جدید'}</h3>
      <div className="fields">
        <label>{directory === 'model' ? 'نام مدل' : 'نام پرسنل'}<input name="name" required maxLength={150} defaultValue={directoryEditing?.name ?? ''} /></label>
        {directory === 'model'
          ? <label>برند<input name="brand" maxLength={100} defaultValue={(directoryEditing as ModelOption | null)?.brand ?? ''} /></label>
          : <>
            <label>نقش<select name="role" defaultValue={(directoryEditing as PersonOption | null)?.role ?? 'driver'} disabled={!!directoryEditing}><option value="driver">راننده</option><option value="supervisor">سرپرست</option><option value="pm">مسئول نگهداری</option><option value="other">سایر پرسنل</option></select></label>
            <label>تلفن<input name="phone" type="tel" maxLength={40} defaultValue={(directoryEditing as PersonOption | null)?.phone ?? ''} /></label>
            <label>توضیحات پرسنل<textarea name="note" maxLength={4000} defaultValue={(directoryEditing as PersonOption | null)?.note ?? ''} /></label>
            {!!directoryEditing && <label className="check"><input name="active" type="checkbox" value="true" defaultChecked={(directoryEditing as PersonOption).active} /> پرسنل فعال</label>}
          </>}
      </div>
      <div className="toolbar"><button disabled={busy}>ذخیره اطلاعات پایه</button><button type="button" disabled={busy} onClick={() => { setDirectory(null); setDirectoryEditing(null); }}>انصراف</button></div>
    </form>}
    {showForm && <form onSubmit={save}>
      <h3>{editing ? 'ویرایش ماشین' : 'ماشین جدید'}</h3>
      <div className="fields">
        <label>کد ماشین<input required maxLength={100} value={draft.code} onChange={e => setDraft({ ...draft, code: e.target.value })} /></label>
        <label>پلاک<input maxLength={100} value={draft.plate} onChange={e => setDraft({ ...draft, plate: e.target.value })} /></label>
        <label>نوع ماشین<input maxLength={100} value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value })} /></label>
        <label>واحد کارکرد<select value={draft.unit} onChange={e => setDraft({ ...draft, unit: e.target.value === 'hour' ? 'hour' : 'km' })}><option value="km">کیلومتر</option><option value="hour">ساعت</option></select></label>
        {assignments.map(([field, label, role]) => {
          const choices = role === 'model'
            ? options.models
            : options.people.filter(person => person.role === role && (person.active || person.id === draft[field]));
          if (field === 'driver_id') return <label key={field}>{label}
            <select aria-label={label} value={draft.floating_driver ? '__floating' : draft.driver_id ?? ''} onChange={e => setDraft({ ...draft, floating_driver: e.target.value === '__floating', driver_id: e.target.value && e.target.value !== '__floating' ? e.target.value : null })}>
              <option value="">بدون انتخاب</option><option value="__floating">راننده ثابت ندارد (متغیر)</option>
              {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
            </select>
            <small>برای ماشین‌هایی که راننده ثابت ندارند، «متغیر» را انتخاب کنید.</small>
          </label>;
          return <label key={field}>{label}
            <select aria-label={label} value={draft[field] ?? ''} onChange={e => setDraft({ ...draft, [field]: e.target.value || null })}>
              <option value="">بدون انتخاب</option>
              {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
            </select>
          </label>;
        })}
        <label>توضیحات<textarea maxLength={4000} value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} /> فعال</label>
      </div>
      <div className="toolbar"><button disabled={busy}>ذخیره پرونده</button><button type="button" disabled={busy} onClick={() => setShowForm(false)}>انصراف</button></div>
    </form>}
    {!profile&&machines.length === 0 && !busy && !error && <p>پرونده‌ای ثبت نشده است.</p>}
    {!profile&&machines.length > 0 && <>
    <div className="machine-grid">{machines.map(machine=>{
      const model=options.models.find(item=>item.id===machine.model_id);
      const driver=options.people.find(item=>item.id===machine.driver_id);
      const pm=options.people.find(item=>item.id===machine.pm_id);
      const recentRepair=cardRepairs.filter(item=>item.machine_id===machine.id&&item.result===null).sort((a,b)=>b.updated_at.localeCompare(a.updated_at))[0];
      const currentStage=cardStages.find(stage=>stage.id===recentRepair?.stage);
      const analysisRows=cardAnalyses.filter(item=>item.machine_id===machine.id);
      const negative=analysisRows.filter(item=>{const r=item.responses??{};return (r.q1==='yes'&&r.q1b==='no')||(r.q2==='yes'&&r.q2b==='no');}).length;
      const maintenanceReading=cardMaintenance.machines.find(item=>item.id===machine.id)?.reading;
      const maintenanceParts=cardMaintenance.parts.filter(item=>item.machine_id===machine.id);
      const over=maintenanceParts.filter(item=>item.state==='over').length;
      const soon=maintenanceParts.filter(item=>item.state==='soon').length;
      const tracked=maintenanceParts.filter(item=>['over','soon','ok'].includes(item.state)).length;
      return <a href={`#machine-${machine.id}`} key={machine.id} className={`machine-card${machine.active?'':' inactive'}`} onClick={event=>{event.preventDefault();void showProfile(machine);}}>
        <div className="mc-top"><span className={`mc-model mdl-${machine.model_id??'unknown'}`}>{model?.name??'مدل ثبت نشده'}</span>{plateContent(machine.plate)}</div>
        <div className="mc-name"><b>{machine.code}</b><small>{machine.type||'نوع ثبت نشده'}{!machine.active?' · غیرفعال':''}</small>
          {recentRepair&&<span className={`spill loc-${currentStage?.loc??(currentStage?.kind==='report'?'factory':currentStage?.kind==='test'?'done':'road')}${cardIsLate(recentRepair)?' late':''}`}><Icon name="wrench"/>{currentStage?.label??recentRepair.stage}</span>}
        </div>
        <dl className="mc-people"><div><dt><Icon name="user"/>راننده</dt><dd>{machine.floating_driver?'متغیر':driver?.name??'—'}</dd></div><div><dt><Icon name="user-cog"/>مسئول PM</dt><dd>{pm?.name??'—'}</dd></div></dl>
        <div className="mc-stats"><div><span>کارکرد</span><b>{maintenanceReading==null?'—':faNumber(maintenanceReading)}</b><small>{machine.unit==='hour'?'ساعت':'کیلومتر'}</small></div>
          <div><span>تحلیل‌ها</span><b>{(permissions.analyses??0)>=1?faNumber(analysisRows.length):'—'}</b><small>{(permissions.analyses??0)>=1?`${faNumber(negative)} سهل‌انگاری`:'بدون دسترسی'}</small></div>
          <div className="mc-maint">{(permissions.maint??0)<1?<span className="st st-muted">وضعیت سرویس نامشخص</span>:over>0?<span className="st st-crit"><Icon name="octagon-alert"/>{faNumber(over)} گذشته</span>:soon>0?<span className="st st-warn"><Icon name="triangle-alert"/>{faNumber(soon)} نزدیک</span>:tracked>0?<span className="st st-good"><Icon name="circle-check"/>همه سالم</span>:<span className="st st-muted"><Icon name="circle-dashed"/>ثبت نشده</span>}</div>
        </div>
      </a>;
    })}</div>
    </>}
    {!profile&&(options.models.length > 0 || options.people.length > 0 || (permissions.settings??0)>=2) && <details id="machine-directory-management" className="directory-management">
      <summary className="visually-hidden">مدیریت تعاریف ماشین‌ها، مدل‌ها و پرسنل</summary>
      <div className="toolbar">
        {(permissions.machines??0)>=2&&<button className="btn btn-primary" disabled={busy} onClick={() => open(null)}>ثبت ماشین</button>}
        {(permissions.settings??0)>=2&&<button className="btn btn-ghost" disabled={busy} onClick={() => openDirectory('model')}>ثبت مدل</button>}
        {(permissions.people??0)>=2&&<button className="btn btn-ghost" disabled={busy} onClick={() => openDirectory('person')}>ثبت پرسنل</button>}
        <button className="btn btn-ghost" disabled={busy} onClick={refresh}>تازه‌سازی</button>
      </div>
      {(options.models.length > 0 || (permissions.settings??0)>=2) && <><h3 id="models-directory">مدل‌ها</h3><div className="table-wrap"><table><thead><tr><th>نام مدل</th><th>برند</th>{(permissions.settings??0)>=2&&<th>عملیات</th>}</tr></thead><tbody>
        {options.models.map(model => <tr key={model.id}><td>{model.name}</td><td>{model.brand || '—'}</td>{(permissions.settings??0)>=2&&<td className="row-actions"><button disabled={busy} onClick={() => openDirectory('model', model)}>ویرایش مدل</button><button type="button" className="btn-danger" disabled={busy||machines.some(machine=>machine.model_id===model.id)} title={machines.some(machine=>machine.model_id===model.id)?'این مدل به ماشین اختصاص دارد':''} onClick={()=>void deleteModel(model)}>حذف مدل</button></td>}</tr>)}
      </tbody></table></div></>}
      {(permissions.people??0)>=1&&options.people.length > 0 && <><h3>پرسنل</h3><div className="table-wrap"><table><thead><tr><th>نام</th><th>نقش</th>{(permissions.people??0)>=2&&<th>تلفن</th>}<th>وضعیت</th>{(permissions.people??0)>=2&&<th>عملیات</th>}</tr></thead><tbody>
        {options.people.map(person => <tr key={person.id}><td>{person.name}</td><td>{person.role === 'driver' ? 'راننده' : person.role === 'supervisor' ? 'سرپرست' : person.role === 'pm' ? 'مسئول نگهداری' : 'سایر پرسنل'}</td>{(permissions.people??0)>=2&&<td>{person.phone || '—'}</td>}<td>{person.active ? 'فعال' : 'غیرفعال'}</td>{(permissions.people??0)>=2&&<td><button disabled={busy} onClick={() => openDirectory('person', person)}>ویرایش پرسنل</button></td>}</tr>)}
      </tbody></table></div></>}
    </details>}
    </div>
  </section>;
}

type RepairStageDefinition = { id: string; label: string; kind: 'report'|'step'|'test'; mode?:'report'|'step'|'wait'|'done'|'test'; loc?:'factory'|'road'|'shop'|'part'|'done'; limit:number|null; who?:string; desc?:string };
const repairStages: RepairStageDefinition[] = [
  {id:'report',label:'اعلام خرابی (ماشین در کارخانه)',kind:'report',mode:'report',loc:'factory',limit:null,who:'سرپرست',desc:'خرابی ثبت شده و ماشین هنوز در کارخانه است'},
  {id:'wait',label:'در انتظار قطعه یا خدمات',kind:'step',mode:'wait',loc:'part',limit:7,who:'تعمیرات',desc:'ماشین برای تعمیر رفته و در انتظار تأمین قطعه یا انجام خدمات تعمیر است'},
  {id:'done',label:'پایان تعمیر',kind:'step',mode:'done',loc:'shop',limit:2,who:'تعمیرات',desc:'تعمیر تمام شده و ماشین باید در کارخانه تست سلامت شود'},
  {id:'test',label:'تست سلامت (ماشین در کارخانه)',kind:'test',mode:'test',loc:'done',limit:null,who:'سرپرست',desc:'ماشین در کارخانه آزمایش می‌شود؛ اگر قبول شود پرونده بایگانی می‌شود و اگر رد شود خرابی جدید ثبت می‌شود'},
];
const repairUrgencies = { urgent: 'فوری', d13: '۱ تا ۳ روز', d47: '۴ تا ۷ روز', none: 'ضروری نیست' };
type RepairStage = string;
type RepairOutcome = 'pass' | 'fail' | 'old' | null;
type Repair = {
  id: string; number: string; machine_id: string; machine_code: string; previous_repair_id?:string|null; previous_repair_number?:string|null; title: string; shop: string; note: string; diagnoser: string;
  report_date: string; expected_date: string | null; refer_date: string | null; return_date: string | null; repair_completed_date?:string|null; test_completed_date?:string|null; test_note?:string; workflow?:string[];
  repairer_note: string; delay_reason: string; stage: RepairStage; urgency: keyof typeof repairUrgencies; version: number; result: RepairOutcome; created_at: string; updated_at?:string; current_stage_since?:string|null;
};
type RepairEvent = {
  id: string; revision:number; stage: RepairStage; result: RepairOutcome; note: string; recorded_at: string; actor_name: string;
  details?:Record<string,string>;
  voided_at?:string|null; voided_by_name?:string|null; undoable?:boolean;
};
const dateFormat = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' });
const dateOnlyFormat = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeZone: 'UTC' });
const todayTehran = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Asia/Tehran',calendar:'gregory' }).formatToParts(new Date()).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const timeTehran = () => new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tehran',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());

function repairStatus(stage: RepairStage, result: RepairOutcome, stages:RepairStageDefinition[]=repairStages): string {
  if (result === 'pass') return 'تست قبول شد';
  if (result === 'fail') return 'تست رد شد';
  if (result === 'old') return 'بسته‌شده پیش از ثبت تست سلامت';
  return stages.find(item=>item.id===stage)?.label??stage;
}
function repairDate(repair: Repair): string { return repair.report_date; }

function RepairStatusBadge({repair,stages,late}:{repair:Repair;stages:RepairStageDefinition[];late:boolean}){
  if(repair.result==='old')return <span className="st st-info"><Icon name="history"/>بسته‌شده پیش از ثبت تست سلامت</span>;
  if(repair.result){const passed=repair.result==='pass';return <span className={`st ${passed?'st-good':'st-crit'}`}><Icon name={passed?'circle-check':'circle-x'}/>{passed?'تست سلامت: قبول':'تست سلامت: رد شد'}</span>;}
  const stage=stages.find(item=>item.id===repair.stage);
  return <span className={`st ${late?'st-crit':stage?.kind==='report'?'st-warn':'st-info'}`}><Icon name={late?'clock':stage?.kind==='report'?'triangle-alert':'wrench'}/>{stage?.label??repair.stage}{late?' · تأخیر':''}</span>;
}

function RepairUrgencyBadge({urgency}:{urgency:keyof typeof repairUrgencies}){
  const tone=({urgent:'crit',d13:'serious',d47:'warn',none:'muted'} as const)[urgency];
  return <span className={`urg urg-${tone}`}>{repairUrgencies[urgency]??'—'}</span>;
}

function RepairDelay({repair}:{repair:Repair}){
  if(!repair.expected_date||!repair.refer_date)return <span className="muted">—</span>;
  const expected=Date.parse(`${repair.expected_date}T00:00:00Z`);
  const end=repair.return_date?Date.parse(`${repair.return_date}T00:00:00Z`):Date.parse(`${todayTehran()}T00:00:00Z`);
  const days=Math.round((end-expected)/86400000);
  if(days>0)return <span className="dl dl-bad"><Icon name="clock"/>{new Intl.NumberFormat('fa-IR').format(days)} روز تأخیر{!repair.return_date&&<small> (تا امروز)</small>}</span>;
  if(!repair.return_date)return <span className="dl dl-wait">{days===0?'موعد بازگشت: امروز':`${new Intl.NumberFormat('fa-IR').format(-days)} روز تا موعد`}</span>;
  return <span className="dl dl-ok"><Icon name="circle-check"/>{days===0?'به‌موقع':`${new Intl.NumberFormat('fa-IR').format(-days)} روز زودتر`}</span>;
}

function Repairs({startNew,initialMachineId,onQuickComplete,canUndo,initialRepairId,onInitialRepairOpened,onAnalyze,canAnalyze}:{startNew:boolean;initialMachineId?:string|null;onQuickComplete:()=>void;canUndo:boolean;initialRepairId?:string|null;onInitialRepairOpened?:()=>void;onAnalyze?:(id:string)=>void;canAnalyze?:boolean}) {
  const [repairs, setRepairs] = useState<Repair[]>([]);
  const [stages,setStages]=useState<RepairStageDefinition[]>(repairStages);
  const [machines, setMachines] = useState<{ id: string; code: string; active: boolean; type:string|null; model_name:string|null }[]>([]);
  const [diagnoserOptions,setDiagnoserOptions]=useState<string[]>([]);
  const [selected, setSelected] = useState<Repair | null>(null);
  const [editingRepair, setEditingRepair] = useState<Repair | null>(null);
  const [followUpOf,setFollowUpOf]=useState<Repair|null>(null);
  const [reportDateDraft, setReportDateDraft] = useState(todayTehran());
  const [machineDraft,setMachineDraft]=useState('');
  const [urgencyDraft,setUrgencyDraft]=useState<keyof typeof repairUrgencies|''>('');
  const [history, setHistory] = useState<RepairEvent[]>([]);
  const [creating, setCreating] = useState(false);
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [machineFilter, setMachineFilter] = useState('');
  const [stageFilter, setStageFilter] = useState<RepairStage | ''>('');
  const [urgencyFilter, setUrgencyFilter] = useState<keyof typeof repairUrgencies | ''>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [lateOnly,setLateOnly]=useState(false);
  const [archiveResultFilter,setArchiveResultFilter]=useState<''|'pass'|'fail'|'old'>('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  async function refresh() {
    setBusy(true);
    setError('');
    try {
      const [items,configured,machineOptions,names]=await Promise.all([api<Repair[]>('/repairs'),api<RepairStageDefinition[]>('/repairs/stages'),api<{id:string;code:string;active:boolean;type:string|null;model_name:string|null}[]>('/repairs/machines'),api<string[]>('/repairs/diagnosers')]);
      setRepairs(items);setStages(configured);setMachines(machineOptions);setDiagnoserOptions(names);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if(startNew){void openNew(null,initialMachineId);onQuickComplete();} }, [startNew]);

  async function openNew(fromRejected:Repair|null=null,preferredMachineId?:string|null) {
    setBusy(true);
    setError('');
    try {
      setMachines(await api('/repairs/machines'));
      setEditingRepair(null);
      setFollowUpOf(fromRejected);
      setReportDateDraft(todayTehran());
      setMachineDraft(fromRejected?.machine_id??preferredMachineId??'');
      setUrgencyDraft(fromRejected?.urgency??'');
      setSelected(null);
      setCreating(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function openEdit(repair: Repair) {
    setBusy(true);
    setError('');
    try {
      setMachines(await api('/repairs/machines'));
      setEditingRepair(repair);
      setReportDateDraft(repair.report_date);
      setMachineDraft(repair.machine_id);
      setUrgencyDraft(repair.urgency);
      setCreating(true);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function openDetails(repair: Repair) {
    const events = await api<RepairEvent[]>(`/repairs/${repair.id}/events`);
    setCreating(false);
    setSelected(repair);
    setHistory(events);
  }

  async function selectRepair(repair: Repair) {
    setBusy(true);
    setError('');
    try {
      await openDetails(repair);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  useEffect(()=>{
    if(!initialRepairId||busy||!repairs.length)return;
    const repair=repairs.find(item=>item.id===initialRepairId);
    if(repair)void selectRepair(repair).finally(()=>onInitialRepairOpened?.());
    else onInitialRepairOpened?.();
  },[initialRepairId,busy,repairs]);

  async function saveRepair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if (!machineDraft) { setError('ابتدا ماشین خراب‌شده را انتخاب کنید.'); return; }
    if (fields.expected_date && fields.report_date && String(fields.expected_date) < String(fields.report_date)) {
      setError('تاریخ پیش‌بینی پایان نمی‌تواند پیش از تاریخ اعلام خرابی باشد.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const repair = editingRepair
        ? await api<Repair>(`/repairs/${editingRepair.id}`, 'PATCH', { ...fields, version: editingRepair.version })
        : await api<Repair>('/repairs', 'POST', fields);
      setCreating(false);
      setEditingRepair(null);
      setFollowUpOf(null);
      setArchived(false);
      setRepairs(items => editingRepair ? items.map(item => item.id === repair.id ? repair : item) : [repair, ...items]);
      await openDetails(repair);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function advance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const updated = await api<Repair>(`/repairs/${selected.id}/events`, 'POST', {
        previous: selected.stage, version: selected.version, note: form.get('note'), result: form.get('result'),
        repairer_note: form.get('repairer_note'), delay_reason: form.get('delay_reason'),
        ...Object.fromEntries(form.entries()),
      });
      setRepairs(items => items.map(item => item.id === updated.id ? updated : item));
      setSelected(updated);
      setArchived(updated.result !== null);
      await openDetails(updated);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function undoLast() {
    if (!selected || !window.confirm('آخرین ثبت مرحله برگردانده می‌شود. پیامک‌های قبلاً ارسال‌شده قابل بازپس‌گیری نیستند. ادامه می‌دهید؟')) return;
    setBusy(true);
    setError('');
    try {
      const updated=await api<Repair>(`/repairs/${selected.id}/events/undo`,'POST',{version:selected.version});
      setRepairs(items=>items.map(item=>item.id===updated.id?updated:item));
      setArchived(updated.result!==null);
      setSelected(updated);
      await openDetails(updated);
    } catch(failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  function isLate(repair:Repair){
    if(repair.result!==null)return false;
    const today=todayTehran();
    const deadlineLate=!!repair.refer_date&&!!repair.expected_date&&repair.expected_date<today;
    const stage=stages.find(item=>item.id===repair.stage);
    const elapsed=repair.current_stage_since?Math.max(0,(Date.now()-Date.parse(repair.current_stage_since))/86400000):null;
    const stageLate=!!stage?.limit&&elapsed!==null&&elapsed>stage.limit;
    const sendLimit=({urgent:0,d13:3,d47:7,none:null} as const)[repair.urgency];
    const reportDay=Date.parse(`${repair.report_date}T00:00:00Z`);
    const sendLate=repair.stage==='report'&&!repair.refer_date&&sendLimit!==null&&Number.isFinite(reportDay)&&Date.parse(`${today}T00:00:00Z`)>reportDay+sendLimit*86400000;
    return deadlineLate||stageLate||sendLate;
  }
  const openRepairs=repairs.filter(repair=>repair.result===null);
  const lateCount=openRepairs.filter(isLate).length;
  const archivedRepairs=repairs.filter(repair=>repair.result!==null);
  const archiveMachineCounts=new Map<string,number>();
  archivedRepairs.forEach(repair=>archiveMachineCounts.set(repair.machine_code,(archiveMachineCounts.get(repair.machine_code)??0)+1));
  const archiveDowntime=(repair:Repair)=>repair.refer_date&&repair.return_date?Math.max(0,Math.round((Date.parse(`${repair.return_date}T00:00:00Z`)-Date.parse(`${repair.refer_date}T00:00:00Z`))/86400000)):null;
  const archiveExport=()=>{
    const cell=(value:unknown)=>{let text=String(value??'');if(/^\s*[-=+@]/.test(text))text="'"+text;return `"${text.replaceAll('"','""')}"`;};
    const rows=[['شماره پرونده','پروندهٔ قبلی','ماشین','شرح خرابی','تاریخ اعلام','مسئول تشخیص','فوریت','تعمیرگاه/تعمیرکار','ارجاع برای تعمیر','موعد پایان','پایان تعمیر','بازگشت به کارخانه','تکمیل تست','نتیجه','شرح تست سلامت','نظر تعمیرکار','علت تأخیر','توضیحات','مدت توقف (روز)'],...archiveRows.map(repair=>[repair.number,repair.previous_repair_number??'',repair.machine_code,repair.title,repair.report_date,repair.diagnoser,repairUrgencies[repair.urgency],repair.shop,repair.refer_date,repair.expected_date,repair.repair_completed_date,repair.return_date,repair.test_completed_date,repair.result==='old'?'بسته‌شده پیش از اجرای تست':repair.result==='pass'?'تست سلامت قبول':'تست سلامت رد',repair.test_note,repair.repairer_note,repair.delay_reason,repair.note,archiveDowntime(repair)])];
    const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='بایگانی-تعمیرات.csv';link.click();URL.revokeObjectURL(url);
  };
  const archivePrint=()=>{
    const popup=window.open('','_blank');if(!popup){setError('پنجرهٔ چاپ باز نشد؛ اجازهٔ بازشدن پنجره را در مرورگر فعال کنید.');return;}
    const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]??char));
    const pass=archiveRows.filter(item=>item.result==='pass').length,fail=archiveRows.filter(item=>item.result==='fail').length,old=archiveRows.filter(item=>item.result==='old').length;
    const tableRows=archiveRows.map((item,index)=>`<tr><td>${escape(item.number||index+1)}</td><td>${escape(item.previous_repair_number?`ادامهٔ ${item.previous_repair_number}`:'—')}</td><td>${escape(item.machine_code)}</td><td>${escape(item.report_date?dateOnlyFormat.format(new Date(item.report_date+'T00:00:00Z')):'—')}</td><td>${escape(item.title)}${item.repairer_note?`<small>نظر تعمیرکار: ${escape(item.repairer_note)}</small>`:''}</td><td>${escape(item.diagnoser||'—')}</td><td>${escape(repairUrgencies[item.urgency])}</td><td>${escape(item.shop||'—')}</td><td>${escape(item.refer_date?dateOnlyFormat.format(new Date(item.refer_date+'T00:00:00Z')):'—')}</td><td>${escape(item.repair_completed_date?dateOnlyFormat.format(new Date(item.repair_completed_date+'T00:00:00Z')):'—')}</td><td>${escape(item.return_date?dateOnlyFormat.format(new Date(item.return_date+'T00:00:00Z')):'—')}</td><td>${escape(item.test_completed_date?dateOnlyFormat.format(new Date(item.test_completed_date+'T00:00:00Z')):'—')}</td><td>${item.result==='old'?'بدون تست':item.result==='pass'?'قبول':'رد'}${item.test_note?`<small>${escape(item.test_note)}</small>`:''}</td><td>${item.delay_reason?escape(item.delay_reason):'—'}${item.note?`<small>${escape(item.note)}</small>`:''}</td><td>${archiveDowntime(item)===null?'—':`${new Intl.NumberFormat('fa-IR').format(archiveDowntime(item)!)} روز`}</td></tr>`).join('');
    popup.document.open();popup.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>بایگانی تعمیرات ناوگان</title><style>@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font:9px Tahoma,Arial,sans-serif;color:#172126;margin:0}header{display:flex;justify-content:space-between;border-bottom:2px solid #174e5a;padding-bottom:8px;margin-bottom:10px}h1{font-size:17px;color:#174e5a;margin:0 0 5px}.muted{color:#657276}.summary{display:flex;gap:8px;margin:9px 0}.summary div{flex:1;padding:7px;border:1px solid #d7dfe1;border-top:3px solid #174e5a;border-radius:4px}.summary b{display:block;font-size:16px;margin-top:3px}.summary .fail{border-top-color:#be3636}.summary .pass{border-top-color:#168351}table{width:100%;border-collapse:collapse;font-size:8px}th,td{padding:5px 4px;border:1px solid #ccd4d6;text-align:right;vertical-align:top}th{background:#edf2f3;color:#173f47}tbody tr:nth-child(even){background:#f8faf9}small{display:block;color:#59656a;margin-top:3px;white-space:pre-wrap}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:28px;text-align:center}.signatures div{border-top:1px solid #68777b;padding-top:6px}.footer{margin-top:10px;text-align:left;color:#7b8588;font-size:8px}</style></head><body><header><div><h1>بایگانی تعمیرات ناوگان</h1><span class="muted">${archiveResultFilter==='pass'?'تست سلامت قبول':archiveResultFilter==='fail'?'تست سلامت رد':archiveResultFilter==='old'?'قبل از راه‌اندازی تست':'همهٔ نتایج'} · ${machineFilter?`ماشین ${escape(machineFilter)} · `:''}${dateFrom||dateTo?`بازهٔ بازگشت ${dateFrom?escape(dateOnlyFormat.format(new Date(dateFrom+'T00:00:00Z'))):'ابتدا'} تا ${dateTo?escape(dateOnlyFormat.format(new Date(dateTo+'T00:00:00Z'))):'امروز'}`:'همهٔ تاریخ‌ها'}</span></div><div class="muted">تاریخ تهیه: ${escape(dateFormat.format(new Date()))}<br>پرونده‌های چاپ‌شده: ${new Intl.NumberFormat('fa-IR').format(archiveRows.length)}</div></header><section class="summary"><div>همهٔ پرونده‌ها<b>${new Intl.NumberFormat('fa-IR').format(archiveRows.length)}</b></div><div class="pass">تست سلامت قبول<b>${new Intl.NumberFormat('fa-IR').format(pass)}</b></div><div class="fail">تست سلامت رد<b>${new Intl.NumberFormat('fa-IR').format(fail)}</b></div><div>قبل از راه‌اندازی تست<b>${new Intl.NumberFormat('fa-IR').format(old)}</b></div></section><table><thead><tr><th>شماره</th><th>پیوند قبلی</th><th>ماشین</th><th>اعلام</th><th>شرح / نظر تعمیرکار</th><th>مسئول تشخیص</th><th>فوریت</th><th>تعمیرگاه</th><th>ارجاع</th><th>پایان تعمیر</th><th>بازگشت</th><th>تکمیل تست</th><th>نتیجه / شرح تست</th><th>علت تأخیر / توضیحات</th><th>مدت توقف</th></tr></thead><tbody>${tableRows||'<tr><td colspan="15">پرونده‌ای برای چاپ وجود ندارد.</td></tr>'}</tbody></table><section class="signatures"><div>تهیه‌کننده · مسئول ماشین‌آلات</div><div>سرپرست</div><div>مدیریت</div></section><div class="footer">سامانه ناوگان سپید · گزارش بایگانی بر اساس فیلترهای جاری</div><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`);popup.document.close();
  };
  const printSelectedRepair=()=>{
    if(!selected)return;
    const popup=window.open('','_blank');if(!popup){setError('پنجرهٔ چاپ باز نشد؛ اجازهٔ بازشدن پنجره را در مرورگر فعال کنید.');return;}
    const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]??char));
    const date=(value?:string|null)=>value?escape(dateOnlyFormat.format(new Date(value+'T00:00:00Z'))):'—';
    const detailLabels:Record<string,string>={shop:'تعمیرگاه',part_name:'قطعه یا خدمت',part_status:'وضعیت تأمین',part_vendor:'فروشنده یا محل تأمین',part_eta:'تحویل تقریبی',expected_date:'موعد پایان'};
    const events=history.map(item=>`<tr><td>${escape(repairStatus(item.stage,item.result,stages))}${item.details?.repeat_current?' · به‌روزرسانی همین مرحله':''}${item.voided_at?' · لغوشده':''}</td><td>${escape(item.actor_name)}</td><td>${escape(dateFormat.format(new Date(item.recorded_at)))}</td><td>${escape(item.note||'—')}${item.details?`<small>${Object.entries(item.details).filter(([key,value])=>detailLabels[key]&&value).map(([key,value])=>`${detailLabels[key]}: ${key==='part_status'?({ordered:'سفارش شد',bought:'خریداری شد',shipping:'در راه',arrived:'رسید'}[value]??value):value}`).map(escape).join(' · ')}</small>`:''}</td></tr>`).join('');
    popup.document.open();popup.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>فرم خرابی ${escape(selected.number)}</title><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font:11px Tahoma,Arial,sans-serif;color:#172126;margin:0;line-height:1.8}header{display:flex;justify-content:space-between;align-items:start;border-bottom:2px solid #174e5a;padding-bottom:10px;margin-bottom:14px}h1{font-size:19px;color:#174e5a;margin:0}.muted{color:#657276}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:12px 0}.field{border:1px solid #d7dfe1;border-radius:5px;padding:7px}.field b{display:block;color:#59656a;font-size:9px}.box{border:1px solid #d7dfe1;border-radius:5px;padding:9px;min-height:34px;white-space:pre-wrap;margin:6px 0 12px}.section{font-weight:bold;color:#174e5a;border-bottom:1px solid #ccd4d6;margin:14px 0 5px}table{width:100%;border-collapse:collapse;font-size:9px;margin-top:8px}th,td{padding:6px;border:1px solid #ccd4d6;text-align:right;vertical-align:top}th{background:#edf2f3}small{display:block;color:#59656a}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:30px;margin-top:36px;text-align:center}.signatures div{border-top:1px solid #68777b;padding-top:6px}.footer{margin-top:20px;text-align:left;color:#7b8588;font-size:8px}</style></head><body><header><div><h1>فرم اعلام خرابی و پیگیری تعمیر</h1><span class="muted">ماشین ${escape(selected.machine_code)} · پروندهٔ ${escape(selected.number)}${selected.previous_repair_number?` · ادامهٔ پروندهٔ ${escape(selected.previous_repair_number)}`:''}</span></div><span class="muted">تاریخ چاپ: ${escape(dateFormat.format(new Date()))}</span></header><section class="grid"><div class="field"><b>تاریخ اعلام</b>${date(selected.report_date)}</div><div class="field"><b>وضعیت پرونده</b>${escape(repairStatus(selected.stage,selected.result,stages))}</div><div class="field"><b>سطح ضرورت</b>${escape(repairUrgencies[selected.urgency])}</div><div class="field"><b>مسئول تشخیص</b>${escape(selected.diagnoser||'—')}</div><div class="field"><b>تاریخ ارجاع برای تعمیر</b>${date(selected.refer_date)}</div><div class="field"><b>موعد پایان پیش‌بینی‌شده</b>${date(selected.expected_date)}</div><div class="field"><b>تعمیرگاه یا تعمیرکار</b>${escape(selected.shop||'—')}</div><div class="field"><b>پایان تعمیر / بازگشت</b>${date(selected.repair_completed_date)} / ${date(selected.return_date)}</div><div class="field"><b>تاریخ تکمیل تست سلامت</b>${date(selected.test_completed_date)}</div><div class="field"><b>نتیجهٔ تست سلامت</b>${selected.result==='pass'?'قبول':selected.result==='fail'?'رد':'در انتظار'}</div></section><div class="section">شرح خرابی</div><div class="box">${escape(selected.title)}</div><div class="section">نظر تعمیرکار</div><div class="box">${escape(selected.repairer_note||'—')}</div><div class="section">شرح تست سلامت</div><div class="box">${escape(selected.test_note||'—')}</div><div class="section">علت تأخیر</div><div class="box">${escape(selected.delay_reason||'—')}</div><div class="section">توضیحات</div><div class="box">${escape(selected.note||'—')}</div><div class="section">تاریخچهٔ مراحل</div><table><thead><tr><th>مرحله</th><th>ثبت‌کننده</th><th>زمان ثبت</th><th>جزئیات و یادداشت</th></tr></thead><tbody>${events||'<tr><td colspan="4">تاریخچه‌ای ثبت نشده است.</td></tr>'}</tbody></table><section class="signatures"><div>مسئول تشخیص خرابی</div><div>سرپرست ماشین‌آلات</div><div>مدیریت</div></section><div class="footer">سامانه ناوگان سپید · فرم پروندهٔ تعمیر</div><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`);popup.document.close();
  };
  const visible = repairs.filter(repair => {
    const date = archived ? repair.return_date??'' : repairDate(repair);
    const text = `${repair.number} ${repair.machine_code} ${repair.title} ${repair.shop} ${repair.diagnoser} ${repair.repairer_note} ${repair.note} ${repair.delay_reason} ${repair.test_note??''}`.toLocaleLowerCase('fa');
    return (repair.result !== null) === archived
      && (!archived || !archiveResultFilter || repair.result===archiveResultFilter)
      && (!query || text.includes(query.trim().toLocaleLowerCase('fa')))
      && (!machineFilter || repair.machine_code === machineFilter)
      && (!stageFilter || repair.stage === stageFilter)
      && (!lateOnly || isLate(repair))
      && (!urgencyFilter || repair.urgency === urgencyFilter)
      && (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
  });
  const archiveRows=visible.slice().sort((a,b)=>(b.return_date??'').localeCompare(a.return_date??'')||(b.updated_at??'').localeCompare(a.updated_at??''));
  const repairRows=visible.slice().sort((a,b)=>b.report_date.localeCompare(a.report_date)||b.created_at.localeCompare(a.created_at));
  const repairExport=()=>{
    const cell=(value:unknown)=>{let text=String(value??'');if(/^\s*[-=+@]/.test(text))text="'"+text;return `"${text.replaceAll('"','""')}"`;};
    const rows=[['شماره پرونده','ماشین','تاریخ اعلام','شرح خرابی','مسئول تشخیص','تعمیرگاه/تعمیرکار','فوریت','پیش‌بینی پایان','تأخیر','مرحله'],...repairRows.map(repair=>[repair.number,repair.machine_code,repair.report_date,repair.title,repair.diagnoser,repair.shop,repairUrgencies[repair.urgency],repair.expected_date??'',isLate(repair)?'دارای تأخیر':'به‌موقع',stages.find(stage=>stage.id===repair.stage)?.label??repair.stage])];
    const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='خرابی-های-درجریان.csv';link.click();URL.revokeObjectURL(url);
  };
  const repairPrint=()=>{
    const popup=window.open('','_blank');if(!popup){setError('پنجرهٔ چاپ باز نشد؛ اجازهٔ بازشدن پنجره را در مرورگر فعال کنید.');return;}
    const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]??char));
    const rows=repairRows.map(repair=>`<tr><td>${escape(repair.number)}</td><td>${escape(repair.machine_code)}</td><td>${escape(dateOnlyFormat.format(new Date(repair.report_date+'T00:00:00Z')))}</td><td>${escape(repair.title)}</td><td>${escape(repair.diagnoser||'—')}</td><td>${escape(repair.shop||'—')}</td><td>${escape(repairUrgencies[repair.urgency])}</td><td>${escape(repair.expected_date?dateOnlyFormat.format(new Date(repair.expected_date+'T00:00:00Z')):'—')}</td><td>${isLate(repair)?'دارای تأخیر':'به‌موقع'}</td><td>${escape(stages.find(stage=>stage.id===repair.stage)?.label??repair.stage)}</td></tr>`).join('');
    popup.document.open();popup.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>گزارش خرابی‌های در جریان</title><style>@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font:10px Tahoma,Arial,sans-serif;color:#172126;margin:0}header{display:flex;justify-content:space-between;border-bottom:2px solid #174e5a;padding-bottom:8px;margin-bottom:12px}h1{font-size:18px;color:#174e5a;margin:0 0 5px}.muted{color:#657276}table{width:100%;border-collapse:collapse}th,td{padding:6px;border:1px solid #ccd4d6;text-align:right;vertical-align:top}th{background:#edf2f3}tbody tr:nth-child(even){background:#f8faf9}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:32px;text-align:center}.signatures div{border-top:1px solid #68777b;padding-top:6px}</style></head><body><header><div><h1>گزارش خرابی‌های در جریان</h1><span class="muted">فیلترها: ${escape([query&&`جست‌وجو ${query}`,machineFilter&&`ماشین ${machineFilter}`,stageFilter&&`مرحله ${stages.find(stage=>stage.id===stageFilter)?.label??stageFilter}`,urgencyFilter&&`فوریت ${repairUrgencies[urgencyFilter]}`,lateOnly&&'فقط دارای تأخیر',dateFrom&&`از ${dateOnlyFormat.format(new Date(dateFrom+'T00:00:00Z'))}`,dateTo&&`تا ${dateOnlyFormat.format(new Date(dateTo+'T00:00:00Z'))}`].filter(Boolean).join(' · ')||'همهٔ پرونده‌های باز')}</span></div><span class="muted">تاریخ تهیه: ${escape(dateOnlyFormat.format(new Date()))}<br>پرونده‌ها: ${new Intl.NumberFormat('fa-IR').format(repairRows.length)}</span></header><table><thead><tr><th>شماره</th><th>ماشین</th><th>اعلام</th><th>شرح خرابی</th><th>مسئول تشخیص</th><th>تعمیرگاه</th><th>فوریت</th><th>پیش‌بینی پایان</th><th>وضعیت تأخیر</th><th>مرحله</th></tr></thead><tbody>${rows||'<tr><td colspan="10">پرونده‌ای برای چاپ وجود ندارد.</td></tr>'}</tbody></table><section class="signatures"><div>مسئول ماشین‌آلات</div><div>سرپرست</div><div>مدیریت</div></section><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`);popup.document.close();
  };
  const currentStageEvent=history.slice().reverse().find(item=>item.stage===selected?.stage&&!item.voided_at);
  const selectedStage=stages.find(item=>item.id===selected?.stage);
  const diagnoserSuggestions=[...new Set([...diagnoserOptions,...repairs.map(item=>item.diagnoser.trim())].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fa'));
  const shopSuggestions=[...new Set(repairs.map(item=>item.shop.trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fa'));
  const closeRepairForm=()=>{setCreating(false);setEditingRepair(null);setFollowUpOf(null);};
  return <div className="repair-view">
    <header className="page-head">
      <div className="ph-text">{creating&&<button type="button" className="machine-profile-breadcrumb" onClick={closeRepairForm}>خرابی‌های در جریان <Icon name="chevron-left"/></button>}<h1>{creating?(editingRepair?'ویرایش خرابی':followUpOf?'اعلام خرابی تازه پس از رد تست':'اعلام خرابی جدید'):archived?'بایگانی تعمیرات':'خرابی‌های در جریان'}</h1><p>{creating?'ماشین و مشخصات خرابی را ثبت کنید.':archived?'پرونده‌های بسته‌شده پس از ثبت نتیجهٔ تست سلامت؛ هیچ سابقه‌ای پاک نمی‌شود.':'خرابی‌هایی که هنوز تست سلامت نشده‌اند؛ پرونده‌های بسته‌شده در «بایگانی تعمیرات» هستند'}</p></div>
      <div className="ph-actions">
        {!creating&&!archived&&<><button className="btn btn-ghost" disabled={busy} onClick={repairExport}><Icon name="file-spreadsheet"/>خروجی اکسل</button><button className="btn btn-ghost" disabled={busy} onClick={repairPrint}><Icon name="printer"/>چاپ گزارش</button><button className="btn btn-ghost" type="button" aria-label="رفتن به بایگانی تعمیرات" onClick={()=>{setSelected(null);setCreating(false);setArchived(true);setStageFilter('');setLateOnly(false);setUrgencyFilter('');setDateFrom('');setDateTo('');}}><Icon name="archive"/>بایگانی</button></>}
        {archived&&<><button className="btn btn-ghost" disabled={busy||!archiveRows.length} onClick={archiveExport}><Icon name="file-spreadsheet"/>خروجی CSV</button><button className="btn btn-ghost" disabled={busy||!archiveRows.length} onClick={archivePrint}><Icon name="printer"/>چاپ بایگانی</button></>}
      </div>
    </header>
    {error && <p role="alert">{error}</p>}
    {creating && <form className="record repair-create-form" aria-label={editingRepair?'ویرایش خرابی':'اعلام خرابی جدید'} key={editingRepair?.id ?? followUpOf?.id ?? 'new-repair'} onSubmit={saveRepair}>
      {followUpOf&&<><input type="hidden" name="previous_repair_id" value={followUpOf.id}/><div className="repair-workflow-note followup"><Icon name="link"/><span>تست سلامت پروندهٔ {followUpOf.number} رد شده است. این خرابی تازه به پروندهٔ قبلی وصل می‌شود و هر دو در تاریخچهٔ ماشین کنار هم دیده می‌شوند.</span></div></>}
      {!editingRepair&&!followUpOf&&<div className="repair-workflow-note"><Icon name="route"/><span>بعد از ثبت، ماشین در مرحلهٔ «{stages.find(stage=>stage.kind==='report')?.label??'اعلام خرابی'}» قرار می‌گیرد. مراحل بعدی (قطعه یا خدمات، پایان تعمیر، تست سلامت) به ترتیب از «ثبت مرحله بعد» وارد می‌شوند.</span></div>}
      {machines.length === 0 && <p>برای ثبت خرابی ابتدا یک ماشین فعال ثبت کنید.</p>}
      <section className="repair-form-card"><div className="repair-form-heading"><h4><Icon name="truck"/>ماشین<i className="req">*</i></h4><span>ماشینی را که خراب شده انتخاب کنید</span></div>
        <input className="visually-hidden" tabIndex={-1} aria-hidden="true" name="machine_id" value={machineDraft} readOnly />
        <div className="machine-pick">{machines.filter(machine=>machine.active||machine.id===editingRepair?.machine_id).map(machine=>{const openCount=repairs.filter(repair=>repair.machine_id===machine.id&&!repair.result&&repair.id!==editingRepair?.id).length;return <button type="button" key={machine.id} className={`machine-choice ${machineDraft===machine.id?'selected':''}`} aria-pressed={machineDraft===machine.id} onClick={()=>setMachineDraft(machine.id)}><span className="repair-machine-model">{machine.model_name||'مدل ثبت نشده'}</span><b>{machine.code}</b><small>{machine.type||'نوع ثبت نشده'}{openCount?` · ${new Intl.NumberFormat('fa-IR').format(openCount)} خرابی باز`:''}{!machine.active?' · غیرفعال':''}</small></button>;})}</div>
      </section>
      <section className="repair-form-card"><div className="repair-form-heading"><h4><Icon name="triangle-alert"/>مشخصات خرابی</h4></div><div className="fields">
        <label><span>تاریخ اعلام خرابی<i className="req">*</i></span><PersianDateInput name="report_date" required value={reportDateDraft} onChange={setReportDateDraft} /></label>
        <label><span>مسئول تشخیص خرابی</span><div className="repair-diagnoser-input"><Icon name="user"/><input name="diagnoser" list="repair-diagnoser-options" maxLength={150} defaultValue={editingRepair?.diagnoser ?? ''} /><Icon name="chevron-down" className="repair-diagnoser-chevron"/></div><datalist id="repair-diagnoser-options">{diagnoserSuggestions.map(name=><option key={name} value={name}/>)}</datalist><small>از فهرست انتخاب کنید یا نام را بنویسید</small></label>
        <label className="span2"><span>نوع خرابی<i className="req">*</i></span><textarea name="title" rows={3} required maxLength={200} defaultValue={editingRepair?.title ?? (followUpOf?`رد در تست سلامت: ${followUpOf.title}`.slice(0,200):'')} /></label>
        <input className="visually-hidden" tabIndex={-1} aria-hidden="true" name="urgency" value={urgencyDraft||'none'} readOnly />
        <div className="urgency-field"><span className="field-label">سطح ضرورت</span><div className="urgency-pick">{Object.entries(repairUrgencies).map(([key,label])=><button type="button" key={key} className={`urgency-choice urgency-${key} ${urgencyDraft===key?'selected':''}`} aria-pressed={urgencyDraft===key} onClick={()=>setUrgencyDraft(key as keyof typeof repairUrgencies)}><b>{key==='d13'?`ارسال با تأخیر ${label}`:key==='d47'?`ارسال با تأخیر ${label}`:label}</b><small>{({urgent:'همین امروز به تعمیر فرستاده شود',d13:'حداکثر ۳ روز پس از اعلام',d47:'حداکثر ۷ روز پس از اعلام',none:'هر زمان امکان داشت'})[key as keyof typeof repairUrgencies]}</small></button>)}</div></div>
      </div></section>
      {editingRepair?<><section className="repair-form-card"><div className="repair-form-heading"><h4><Icon name="send"/>تعمیر</h4><span>تاریخ‌ها از روی مراحل ثبت‌شده پر می‌شوند</span></div><div className="fields">
        <label>تاریخ پیش‌بینی پایان تعمیر<PersianDateInput name="expected_date" min={editingRepair?.refer_date ?? reportDateDraft} defaultValue={editingRepair?.expected_date ?? ''} /></label>
        <label>تعمیرگاه<input name="shop" list="repair-shop-options" maxLength={150} defaultValue={editingRepair?.shop ?? followUpOf?.shop ?? ''} /><datalist id="repair-shop-options">{shopSuggestions.map(name=><option key={name} value={name}/>)}</datalist></label>
      </div></section><section className="repair-form-card"><div className="repair-form-heading"><h4><Icon name="clipboard-check"/>نتیجهٔ تعمیر</h4></div><div className="fields">
        <label>نظر تعمیرکار<textarea name="repairer_note" maxLength={4000} defaultValue={editingRepair?.repairer_note ?? ''} /></label>
        <label>علت تأخیر<textarea name="delay_reason" maxLength={4000} defaultValue={editingRepair?.delay_reason ?? ''} /></label>
        <label className="span2">توضیحات خرابی<textarea name="note" maxLength={4000} defaultValue={editingRepair?.note ?? ''} /></label>
      </div></section></>:<section className="repair-form-card"><div className="repair-form-heading"><h4>توضیحات (اختیاری)</h4></div><div className="fields"><label className="span2">توضیحات<textarea name="note" maxLength={4000} defaultValue={followUpOf?.note??''}/></label></div></section>}
      <div className="repair-form-actions"><button className="btn btn-ghost" type="button" disabled={busy} onClick={closeRepairForm}>انصراف</button><button className="btn btn-primary" disabled={busy || machines.length === 0}>{editingRepair ? 'ذخیره تغییرات' : 'ثبت خرابی'}</button></div>
    </form>}
    {!creating&&<div className="repair-list-content">
    {selected && <article className="record" aria-label="جزئیات خرابی">
      <div className="toolbar"><h3>{selected.title}</h3><button disabled={busy} onClick={printSelectedRepair}>چاپ فرم پرونده</button>{canAnalyze&&onAnalyze&&<button disabled={busy} onClick={()=>onAnalyze(selected.id)}>تحلیل این خرابی</button>}<button disabled={busy} onClick={()=>void openEdit(selected)}>ویرایش پرونده</button>
        {canUndo&&history.at(-1)?.undoable&&!history.at(-1)?.voided_at&&history.at(-1)?.revision===selected.version&&<button disabled={busy}
          onClick={()=>void undoLast()}>برگرداندن آخرین ثبت</button>}</div>
      <p>{selected.machine_code} · {repairStatus(selected.stage, selected.result,stages)}</p>
      {selected.previous_repair_number&&<p>ادامهٔ پروندهٔ قبلی: {selected.previous_repair_number}</p>}
      {selected.shop && <p>تعمیرگاه {selected.shop}</p>}
      <p>اعلام: {dateOnlyFormat.format(new Date(selected.report_date + 'T00:00:00Z'))}{selected.diagnoser ? ` · مسئول تشخیص: ${selected.diagnoser}` : ''}{selected.expected_date ? ` · پیش‌بینی پایان: ${dateOnlyFormat.format(new Date(selected.expected_date + 'T00:00:00Z'))}` : ''}</p>
      {selected.note && <p>{selected.note}</p>}
      {selected.repairer_note && <p><b>نظر تعمیرکار: </b>{selected.repairer_note}</p>}{selected.delay_reason && <p><b>علت تأخیر: </b>{selected.delay_reason}</p>}
      {selected.result==='fail'&&<button disabled={busy} onClick={()=>void openNew(selected)}>اعلام خرابی جدید برای همین ماشین</button>}
      <h4>تاریخچهٔ مراحل</h4>
      <ol>{history.map(item => <li key={item.id} className={item.voided_at?'voided-event':undefined}>
        <strong>{repairStatus(item.stage, item.result,stages)}</strong>{item.details?.repeat_current&&' · به‌روزرسانی همین مرحله'}{item.voided_at&&' · لغوشده'} · {item.actor_name} · {dateFormat.format(new Date(item.recorded_at))}
        {item.note && <p>{item.note}</p>}
        {item.details&&<p>{[['shop','تعمیرگاه'],['part_name','قطعه یا خدمت'],['part_status','وضعیت تأمین'],['part_vendor','فروشنده یا محل تأمین'],['part_eta','تحویل تقریبی'],['expected_date','موعد پایان']].filter(([key])=>item.details?.[key]).map(([key,label])=>`${label}: ${key==='part_status'?({ordered:'سفارش شد',bought:'خریداری شد',shipping:'در راه',arrived:'رسید'}[item.details?.[key]??'']??item.details?.[key]):item.details?.[key]}`).join(' · ')}</p>}
      </li>)}</ol>
      {stages.findIndex(stage=>stage.id===selected.stage)>=0&&stages.findIndex(stage=>stage.id===selected.stage)<stages.length-1&& <form key={selected.id + selected.version} onSubmit={advance}>
        {(()=>{const next=stages[stages.findIndex(stage=>stage.id===selected.stage)+1];return <>
        <h4>{next.label}</h4>
        {next.kind === 'test' && <label>نتیجهٔ تست<select aria-label="نتیجهٔ تست" name="result" required defaultValue="">
          <option value="" disabled>انتخاب نتیجه</option>
          <option value="pass">قبول</option><option value="fail">رد</option>
        </select></label>}
        {next.mode === 'done' && <label>نظر تعمیرکار<textarea name="repairer_note" maxLength={4000} /></label>}
        {next.kind === 'test' && <label>علت تأخیر<textarea name="delay_reason" maxLength={4000} /></label>}
        <label>یادداشت مرحله<textarea name="note" maxLength={4000} /></label>
        {next.mode==='wait'&&<>
          <label>تعمیرگاه یا تعمیرکار<input name="shop" maxLength={150} defaultValue={selected.shop} /></label>
          <label>قطعه یا خدمت مورد انتظار<input name="part_name" maxLength={200} placeholder="مثلاً قطعه، تراشکاری یا سرویس" /></label>
          <label>وضعیت تأمین<select name="part_status" defaultValue="ordered"><option value="ordered">سفارش یا درخواست داده شد</option><option value="bought">خریداری یا هماهنگ شد</option><option value="shipping">در راه تعمیرگاه</option><option value="arrived">رسید؛ تعمیر در حال انجام</option></select></label>
          <label>فروشنده یا محل تأمین<input name="part_vendor" maxLength={200} /></label>
          <label>تحویل تقریبی قطعه یا خدمت<PersianDateInput name="part_eta" /></label>
          <label>موعد پیش‌بینی پایان تعمیر<PersianDateInput name="expected_date" defaultValue={selected.expected_date??''} /></label>
        </>}
        <div className="fields"><label>تاریخ ثبت مرحله<PersianDateInput name="event_date" defaultValue={todayTehran()} /></label><label>ساعت ثبت مرحله<input name="event_time" type="time" defaultValue={timeTehran()} /></label></div>
        <button disabled={busy}>ثبت مرحلهٔ بعد</button>
        </>;})()}
      </form>}
      {selectedStage?.mode==='wait'&&<form className="record" key={`${selected.id}-${selected.version}-${history.at(-1)?.id??'repeat'}-${history.at(-1)?.voided_at??'active'}`} onSubmit={advance}>
        <input type="hidden" name="repeat_current" value="true"/><h4>به‌روزرسانی همین مرحله</h4>
        <label>تعمیرگاه یا تعمیرکار<input name="shop" maxLength={150} defaultValue={selected.shop}/></label>
        <label>قطعه یا خدمت مورد انتظار<input name="part_name" maxLength={200} defaultValue={currentStageEvent?.details?.part_name??''}/></label>
        <label>وضعیت تأمین<select name="part_status" defaultValue={currentStageEvent?.details?.part_status??'ordered'}><option value="ordered">سفارش یا درخواست داده شد</option><option value="bought">خریداری یا هماهنگ شد</option><option value="shipping">در راه تعمیرگاه</option><option value="arrived">رسید؛ تعمیر در حال انجام</option></select></label>
        <label>فروشنده یا محل تأمین<input name="part_vendor" maxLength={200} defaultValue={currentStageEvent?.details?.part_vendor??''}/></label>
        <label>تحویل تقریبی قطعه یا خدمت<PersianDateInput name="part_eta" defaultValue={currentStageEvent?.details?.part_eta??''}/></label>
        <label>موعد پیش‌بینی پایان تعمیر<PersianDateInput name="expected_date" defaultValue={selected.expected_date??''}/></label>
        <label>یادداشت این مرحله<textarea name="note" maxLength={4000}/></label>
        <div className="fields"><label>تاریخ ثبت مرحله<PersianDateInput name="event_date" defaultValue={todayTehran()}/></label><label>ساعت ثبت مرحله<input name="event_time" type="time" defaultValue={timeTehran()}/></label></div>
        <button disabled={busy}>ثبت به‌روزرسانی همین مرحله</button>
      </form>}
    </article>}
    {!archived&&<div className="sum-tiles dyn" style={{'--cols':Math.min(6,stages.length+1)} as CSSProperties} aria-label="خلاصهٔ خرابی‌های باز">
      <button type="button" className={`sum-tile muted ${!stageFilter&&!lateOnly?'on':''}`} aria-pressed={!stageFilter&&!lateOnly} onClick={()=>{setStageFilter('');setLateOnly(false);}}><b>{new Intl.NumberFormat('fa-IR').format(openRepairs.length)}</b><span><Icon name="layers"/>همهٔ خرابی‌های باز</span></button>
      {stages.slice(0,-1).map(stage=><button type="button" key={stage.id} className={`sum-tile ${stage.kind==='report'?'info':stage.kind==='step'?'warn':'muted'} ${stageFilter===stage.id?'on':''}`} aria-pressed={stageFilter===stage.id&&!lateOnly} onClick={()=>{setStageFilter(stageFilter===stage.id?'':stage.id);setLateOnly(false);}}><b>{new Intl.NumberFormat('fa-IR').format(openRepairs.filter(repair=>repair.stage===stage.id).length)}</b><span><Icon name={stage.kind==='report'?'factory':stage.label.includes('قطعه')?'package':'wrench'}/>{stage.label}</span></button>)}
      <button type="button" className={`sum-tile crit ${lateOnly?'on':''}`} aria-pressed={lateOnly} onClick={()=>{setStageFilter('');setLateOnly(!lateOnly);}}><b>{new Intl.NumberFormat('fa-IR').format(lateCount)}</b><span><Icon name="clock"/>دارای تأخیر</span></button>
    </div>}
    {archived&&<>
      <div className="sum-tiles dyn archive-summary" style={{'--cols':4} as CSSProperties} aria-label="خلاصهٔ بایگانی تعمیرات">
        <button type="button" className={`sum-tile muted ${!archiveResultFilter?'on':''}`} aria-pressed={!archiveResultFilter} onClick={()=>setArchiveResultFilter('')}><b>{new Intl.NumberFormat('fa-IR').format(archivedRepairs.length)}</b><span><Icon name="archive"/>همهٔ پرونده‌های بایگانی</span></button>
        <button type="button" className={`sum-tile good ${archiveResultFilter==='pass'?'on':''}`} aria-pressed={archiveResultFilter==='pass'} onClick={()=>setArchiveResultFilter(archiveResultFilter==='pass'?'':'pass')}><b>{new Intl.NumberFormat('fa-IR').format(archivedRepairs.filter(repair=>repair.result==='pass').length)}</b><span><Icon name="circle-check"/>تست سلامت قبول</span></button>
        <button type="button" className={`sum-tile crit ${archiveResultFilter==='fail'?'on':''}`} aria-pressed={archiveResultFilter==='fail'} onClick={()=>setArchiveResultFilter(archiveResultFilter==='fail'?'':'fail')}><b>{new Intl.NumberFormat('fa-IR').format(archivedRepairs.filter(repair=>repair.result==='fail').length)}</b><span><Icon name="circle-x"/>تست سلامت رد</span></button>
        <button type="button" className={`sum-tile muted ${archiveResultFilter==='old'?'on':''}`} aria-pressed={archiveResultFilter==='old'} onClick={()=>setArchiveResultFilter(archiveResultFilter==='old'?'':'old')}><b>{new Intl.NumberFormat('fa-IR').format(archivedRepairs.filter(repair=>repair.result==='old').length)}</b><span><Icon name="history"/>قبل از راه‌اندازی تست</span></button>
      </div>
      {!!archiveMachineCounts.size&&<div className="chips-row"><button className={`chip ${!machineFilter?'on':''}`} onClick={()=>setMachineFilter('')}>همهٔ ماشین‌ها</button>{[...archiveMachineCounts].sort(([a],[b])=>a.localeCompare(b,'fa')).map(([code,count])=><button key={code} className={`chip ${machineFilter===code?'on':''}`} onClick={()=>setMachineFilter(machineFilter===code?'':code)}><bdi>{code}</bdi> ({new Intl.NumberFormat('fa-IR').format(count)})</button>)}</div>}
    </>}
    <div className={`fields report-filters repair-filter-grid ${archived?'archive':'open'}`} aria-label="جست‌وجو و فیلتر پرونده‌ها">
      <label>جستجو<div className="repair-search-input"><Icon name="search"/><input value={query} onChange={event => setQuery(event.target.value)} placeholder={archived?'شماره، ماشین یا شرح پرونده':'نوع خرابی، تعمیرگاه، مسئول تشخیص…'} /></div></label>
      <label>ماشین<select value={machineFilter} onChange={event => setMachineFilter(event.target.value)}><option value="">همه</option>{machines.map(item=><option key={item.id} value={item.code}>{item.code}</option>)}</select></label>
      {!archived&&<><label>وضعیت<select value={lateOnly?'__late':stageFilter} onChange={event => {if(event.target.value==='__late'){setStageFilter('');setLateOnly(true);}else{setStageFilter(event.target.value);setLateOnly(false);}}}><option value="">همهٔ خرابی‌های باز</option>{stages.filter(stage=>stage.kind!=='test').map(stage=><option key={stage.id} value={stage.id}>{stage.label}</option>)}<option value="__late">دارای تأخیر</option></select></label>
      <label>سطح ضرورت<select value={urgencyFilter} onChange={event => setUrgencyFilter(event.target.value as keyof typeof repairUrgencies | '')}><option value="">همه</option>{Object.entries(repairUrgencies).map(([key,label])=><option key={key} value={key}>{key==='d13'?`ارسال با تأخیر ${label}`:key==='d47'?`ارسال با تأخیر ${label}`:label}</option>)}</select></label></>}
      <label className={archived?'':'repair-date-filter'}>{archived?'از تاریخ بازگشت':'از تاریخ اعلام'}<PersianDateInput value={dateFrom} max={dateTo||undefined} onChange={setDateFrom} /></label>
      <label className={archived?'':'repair-date-filter'}>{archived?'تا تاریخ بازگشت':'تا تاریخ'}<PersianDateInput value={dateTo} min={dateFrom||undefined} onChange={setDateTo} /></label>
      {(query||machineFilter||stageFilter||urgencyFilter||dateFrom||dateTo||lateOnly||archiveResultFilter)&&<button type="button" onClick={() => { setQuery(''); setMachineFilter(''); setStageFilter(''); setUrgencyFilter(''); setDateFrom(''); setDateTo(''); setLateOnly(false);setArchiveResultFilter(''); }}>پاک‌کردن فیلترها</button>}
    </div>
    {!busy&&(visible.length>0||archived)&&<p>نمایش {new Intl.NumberFormat('fa-IR').format(visible.length)} از {new Intl.NumberFormat('fa-IR').format(repairs.filter(item => (item.result !== null) === archived).length)} پروندهٔ {archived ? 'بایگانی' : 'باز'}</p>}
    {!visible.length&&!busy&&!archived&&<section className="card flush"><div className="empty"><div className="empty-ic"><Icon name={openRepairs.length?'search-x':'shield-check'}/></div><h4>{openRepairs.length?'موردی با این فیلترها پیدا نشد':'خرابی بازی وجود ندارد'}</h4>{openRepairs.length===0&&<><p>همه خرابی‌ها تست سلامت شده و در بایگانی‌اند.</p><button className="btn btn-primary" type="button" onClick={()=>void openNew()}><Icon name="plus"/>اعلام خرابی</button></>}</div></section>}
    {!visible.length&&!busy&&archived&&<p>پرونده‌ای با این فیلترها در بایگانی پیدا نشد.</p>}
    {archived&&archiveRows.length>0&&<section className="card flush"><div className="table-wrap"><table className="table rep-table archive-table">
      <thead><tr><th>شماره</th><th>ماشین</th><th>شرح خرابی</th><th>تاریخ اعلام</th><th>ارجاع برای تعمیر</th><th>پایان تعمیر</th><th>بازگشت</th><th>تکمیل تست</th><th>نتیجه</th><th>مدت توقف</th><th>عملیات</th></tr></thead>
      <tbody>{archiveRows.map(repair=><tr key={repair.id} className="repair-row" tabIndex={0} aria-label={`پروندهٔ بایگانی ${repair.number}، ماشین ${repair.machine_code}، ${repair.title}`} onClick={event=>{if(!(event.target as HTMLElement).closest('button,a,input,select,textarea'))void selectRepair(repair);}} onKeyDown={event=>{if((event.key==='Enter'||event.key===' ')&&event.target===event.currentTarget){event.preventDefault();void selectRepair(repair);}}}>
        <td>{repair.number}{repair.previous_repair_number&&<small> ادامهٔ {repair.previous_repair_number}</small>}</td><td>{repair.machine_code}</td><td className="cell-topic"><b>{repair.title}</b>{repair.repairer_note&&<small>تعمیرکار: {repair.repairer_note}</small>}</td>
        <td>{dateOnlyFormat.format(new Date(repair.report_date+'T00:00:00Z'))}</td><td>{repair.refer_date?dateOnlyFormat.format(new Date(repair.refer_date+'T00:00:00Z')):'—'}</td><td>{repair.repair_completed_date?dateOnlyFormat.format(new Date(repair.repair_completed_date+'T00:00:00Z')):'—'}</td><td>{repair.return_date?dateOnlyFormat.format(new Date(repair.return_date+'T00:00:00Z')):'—'}</td><td>{repair.test_completed_date?dateOnlyFormat.format(new Date(repair.test_completed_date+'T00:00:00Z')):'—'}</td>
        <td><RepairStatusBadge repair={repair} stages={stages} late={false}/>{repair.test_note&&<small className="archive-test-note">{repair.test_note}</small>}</td><td>{archiveDowntime(repair)===null?'—':`${new Intl.NumberFormat('fa-IR').format(archiveDowntime(repair)!)} روز`}</td><td><button disabled={busy} onClick={()=>void selectRepair(repair)}>جزئیات</button></td>
      </tr>)}</tbody>
    </table></div></section>}
    {!archived&&visible.length > 0 && <section className="card flush"><div className="table-wrap"><table className="table rep-table">
      <thead><tr><th>شماره</th><th>ماشین</th><th>تاریخ اعلام</th><th>خرابی</th><th>مسئول تشخیص</th><th>تعمیرگاه</th><th>فوریت</th><th>پیش‌بینی پایان</th><th>تأخیر</th><th>وضعیت</th><th>عملیات</th></tr></thead>
      <tbody>{repairRows.map(repair => <tr key={repair.id} className={`${isLate(repair)?'rep-late':''} repair-row`} tabIndex={0} aria-label={`پرونده ${repair.number}، ماشین ${repair.machine_code}، ${repair.title}`} onClick={event=>{if(!(event.target as HTMLElement).closest('button,a,input,select,textarea'))void selectRepair(repair);}} onKeyDown={event=>{if((event.key==='Enter'||event.key===' ')&&event.target===event.currentTarget){event.preventDefault();void selectRepair(repair);}}}>
        <td>{repair.number}{repair.previous_repair_number&&<small> ادامهٔ {repair.previous_repair_number}</small>}</td><td>{repair.machine_code}</td><td>{dateOnlyFormat.format(new Date(repair.report_date+'T00:00:00Z'))}</td><td className="cell-topic">{repair.title}{repair.delay_reason?.trim()?null:isLate(repair)&&repair.return_date?<small className="repair-warning">ثبت علت تأخیر فراموش شده</small>:null}</td>
        <td>{repair.diagnoser||'—'}</td><td>{repair.shop||'—'}</td><td><RepairUrgencyBadge urgency={repair.urgency}/></td><td>{repair.expected_date?dateOnlyFormat.format(new Date(repair.expected_date+'T00:00:00Z')):'—'}</td><td><RepairDelay repair={repair}/></td><td><RepairStatusBadge repair={repair} stages={stages} late={isLate(repair)}/></td>
        <td><button disabled={busy} onClick={() => void selectRepair(repair)}>جزئیات</button></td>
      </tr>)}</tbody>
    </table></div></section>}
    </div>}
  </div>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
