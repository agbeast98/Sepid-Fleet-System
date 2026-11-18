import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { icons } from './icons';
import { api, errorMessage } from './api';

export type Section = 'dashboard' | 'status' | 'machines' | 'people' | 'actions' | 'repairs' | 'maintenance' | 'parts' | 'users' | 'analyses' | 'settings' | 'reports' | 'archive' | 'sms' | 'migration' | 'backups' | 'guide';
type QuickAction = 'repair' | 'analysis' | 'stage';
type NavigationItem = { label: string; icon: string; section?: Section; action?: QuickAction; externalHref?: string; badge?: 'status' | 'repairs' | 'maint' | 'backup' };
type BackupSummary = { tone: 'good' | 'warn'; title: string; subtitle: string };
type RepairBadgeItem = { stage: string; result: string | null; urgency: 'urgent' | 'd13' | 'd47' | 'none'; report_date: string; refer_date?: string | null; expected_date?: string | null; current_stage_since?: string | null };
type RepairStageBadge = { id: string; limit: number | null };
type SidebarBadges = { status?: number; repairs?: number; maint?: number; statusLate?: boolean; repairsLate?: boolean };
const groups: { title: string; items: NavigationItem[] }[] = [
  { title: 'نمای کلی', items: [{ section: 'dashboard', label: 'داشبورد', icon: 'layout-dashboard' }] },
  { title: 'کار روزانه', items: [
    { section: 'status', label: 'وضعیت ماشین‌ها', icon: 'map-pin', badge: 'status' },
    { action: 'repair', label: 'اعلام خرابی', icon: 'circle-plus' },
    { action: 'stage', label: 'ثبت مرحله بعد', icon: 'route' },
  ] },
  { title: 'تعمیرات و ماشین‌ها', items: [
    { section: 'repairs', label: 'خرابی‌های در جریان', icon: 'wrench', badge: 'repairs' },
    { section: 'machines', label: 'پرونده ماشین‌ها', icon: 'truck' },
    { section: 'people', label: 'پرسنل', icon: 'users' },
  ] },
  { title: 'نگهداری و قطعات', items: [
    { section: 'maintenance', label: 'نگهداری پیشگیرانه', icon: 'gauge', badge: 'maint' },
    { section: 'parts', label: 'قطعات و جایگزین‌ها', icon: 'arrow-left-right' },
  ] },
  { title: 'تحلیل و اقدامات مدیریتی', items: [
    { section: 'analyses', label: 'تحلیل‌های خرابی', icon: 'clipboard-list' },
    { action: 'analysis', label: 'ثبت تحلیل جدید', icon: 'clipboard-plus' },
    { section: 'actions', label: 'اقدامات مدیریتی', icon: 'gavel' },
  ] },
  { title: 'بایگانی و مدیریت سامانه', items: [
    { section: 'archive', label: 'بایگانی تعمیرات', icon: 'archive' },
    { section: 'reports', label: 'گزارش تعمیرات', icon: 'file-text' },
    { section: 'settings', label: 'تنظیمات و تعاریف', icon: 'settings' },
    { section: 'users', label: 'کاربران و دسترسی‌ها', icon: 'user' },
    { section: 'sms', label: 'تنظیمات و گزارش پیامک', icon: 'message-square' },
    { section: 'migration', label: 'انتقال دادهٔ نسخهٔ قبلی', icon: 'database' },
    { section: 'backups', label: 'پشتیبان‌های سرور', icon: 'database', badge: 'backup' },
    { section: 'guide', label: 'رویه کار با سامانه', icon: 'book-open' },
    { externalHref: '/legacy-online.html', label: 'محیط سازگار با نسخهٔ قبلی', icon: 'layers' },
  ] },
];
const permissionFor: Partial<Record<Section, string>> = { dashboard: 'dashboard', status: 'status', machines: 'machines', people: 'people', actions: 'people', repairs: 'repairs', reports: 'repairs', archive: 'repairs', maintenance: 'maint', parts: 'parts', analyses: 'analyses', settings: 'settings', sms: 'sms' };

export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <svg className={`ic ${className}`.trim()} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: icons[name] ?? '' }} />;
}

type SearchHit = { section: Section; title: string; detail: string };

export function Shell({ section, navigate, onQuickCreate, onQuickStage, name, companyName, orgName, themeSetting, onThemeSettingChange, isAdmin, permissions, logout, pending, children }: {
  section: Section; navigate: (section: Section) => void; onQuickCreate: (section: 'repairs'|'analyses') => void; onQuickStage: () => void; name: string; companyName: string; orgName: string; themeSetting: 'auto' | 'light' | 'dark'; onThemeSettingChange: (theme: 'auto' | 'light' | 'dark') => void; isAdmin: boolean; permissions: Record<string, number>; logout: () => void;
  pending: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [backupSummary, setBackupSummary] = useState<BackupSummary>({ tone: 'warn', title: 'در حال بررسی پشتیبان', subtitle: 'وضعیت نسخه‌های سرور' });
  const [sidebarBadges, setSidebarBadges] = useState<SidebarBadges>({});
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordNotice, setPasswordNotice] = useState('');
  const searchInput=useRef<HTMLInputElement>(null);
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem('sepid:theme');
      return saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });
  const permissionsKey = Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}:${value}`).join('|');
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('sepid:theme', dark ? 'dark' : 'light'); } catch { /* Theme remains available for this session. */ }
  }, [dark]);
  useEffect(() => {
    setDark(themeSetting === 'auto' ? matchMedia('(prefers-color-scheme: dark)').matches : themeSetting === 'dark');
  }, [themeSetting]);
  useEffect(() => {
    if (!isAdmin) return;
    let current = true;
    api<{ name: string; createdAt: string }[]>('/backups').then(items => {
      if (!current) return;
      const latest = items.map(item => ({ ...item, time: new Date(item.createdAt).getTime() })).filter(item => Number.isFinite(item.time)).sort((a,b) => b.time - a.time)[0];
      if (!latest) { setBackupSummary({ tone: 'warn', title: 'هنوز پشتیبان نگرفته‌اید', subtitle: 'برای امنیت داده‌ها نسخه بگیرید' }); return; }
      const ageDays = Math.max(0, Math.floor((Date.now() - latest.time) / 86_400_000));
      const fresh = ageDays <= 7;
      const created = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' }).format(latest.time);
      setBackupSummary(fresh
        ? { tone: 'good', title: 'پشتیبان به‌روز است', subtitle: `آخرین: ${created}` }
        : { tone: 'warn', title: `${new Intl.NumberFormat('fa-IR').format(ageDays)} روز از آخرین پشتیبان`, subtitle: 'نسخه‌های پشتیبان را بررسی کنید' });
    }).catch(() => { if (current) setBackupSummary({ tone: 'warn', title: 'وضعیت پشتیبان در دسترس نیست', subtitle: 'برای بررسی دوباره وارد شوید' }); });
    return () => { current = false; };
  }, [isAdmin]);
  useEffect(() => {
    let current = true;
    let timer = 0;
    const canSeeRepairs = (permissions.repairs ?? 0) >= 1;
    const canSeeStatus = (permissions.status ?? 0) >= 1;
    const canSeeMaintenance = (permissions.maint ?? 0) >= 1;
    const today = () => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Tehran', calendar: 'gregory' }).formatToParts(new Date()).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const isLate = (repair: RepairBadgeItem, stages: RepairStageBadge[]) => {
      if (repair.result !== null) return false;
      const day = today();
      const deadlineLate = !!repair.refer_date && !!repair.expected_date && repair.expected_date < day;
      const stage = stages.find(item => item.id === repair.stage);
      const elapsed = repair.current_stage_since ? Math.max(0, (Date.now() - Date.parse(repair.current_stage_since)) / 86_400_000) : null;
      const stageLate = !!stage?.limit && elapsed !== null && elapsed > stage.limit;
      const sendLimit = ({ urgent: 0, d13: 3, d47: 7, none: null } as const)[repair.urgency];
      const reportDay = Date.parse(`${repair.report_date}T00:00:00Z`);
      const sendLate = repair.stage === 'report' && !repair.refer_date && sendLimit !== null && Number.isFinite(reportDay)
        && Date.parse(`${day}T00:00:00Z`) > reportDay + sendLimit * 86_400_000;
      return deadlineLate || stageLate || sendLate;
    };
    const refresh = async () => {
      const next: SidebarBadges = {};
      const jobs: Promise<void>[] = [];
      if (canSeeRepairs || canSeeStatus) {
        jobs.push((async () => {
          try {
            let repairs: RepairBadgeItem[];
            let stages: RepairStageBadge[];
            if (canSeeRepairs) {
              [repairs, stages] = await Promise.all([
                api<RepairBadgeItem[]>('/repairs'),
                api<RepairStageBadge[]>('/repairs/stages'),
              ]);
            } else {
              const status = await api<{ repairs: RepairBadgeItem[]; stages: RepairStageBadge[] }>('/status');
              repairs = status.repairs;
              stages = status.stages;
            }
            const open = repairs.filter(repair => repair.result === null);
            const late = open.filter(repair => isLate(repair, stages)).length;
            if (canSeeRepairs) { next.repairs = late || open.length; next.repairsLate = late > 0; }
            if (canSeeStatus) { next.status = late || open.length; next.statusLate = late > 0; }
          } catch { /* Badge data is optional; navigation remains available. */ }
        })());
      }
      if (canSeeMaintenance) {
        jobs.push(api<{ parts: { state: string }[] }>('/maintenance').then(data => {
          next.maint = data.parts.filter(part => part.state === 'over').length;
        }).catch(() => undefined));
      }
      await Promise.all(jobs);
      if (current) setSidebarBadges(next);
    };
    void refresh();
    timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [permissionsKey, section]);
  useEffect(() => {
    document.body.classList.toggle('nav-open', open);
    return () => document.body.classList.remove('nav-open');
  }, [open]);
  useEffect(() => {
    document.body.classList.toggle('has-modal', passwordOpen);
    return () => document.body.classList.remove('has-modal');
  }, [passwordOpen]);
  useEffect(() => {
    if (!passwordOpen) return;
    function escape(event: KeyboardEvent) { if (event.key === 'Escape' && !passwordBusy) setPasswordOpen(false); }
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [passwordOpen, passwordBusy]);
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError('');
    const values = new FormData(event.currentTarget);
    const currentPassword = String(values.get('currentPassword') ?? '');
    const password = String(values.get('password') ?? '');
    if (password !== String(values.get('confirmPassword') ?? '')) { setPasswordError('رمز جدید و تکرار آن یکسان نیستند.'); return; }
    if (password === currentPassword) { setPasswordError('رمز جدید باید با رمز فعلی متفاوت باشد.'); return; }
    setPasswordBusy(true);
    try {
      await api('/auth/password', 'POST', { currentPassword, password, confirmPassword: password });
      setPasswordOpen(false);
      setPasswordNotice('رمز عبور با موفقیت تغییر کرد. نشست‌های دیگر بسته شدند.');
      window.setTimeout(() => setPasswordNotice(''), 4500);
    } catch (failure) { setPasswordError(errorMessage(failure)); }
    finally { setPasswordBusy(false); }
  }
  useEffect(() => {
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') setOpen(false); }
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  useEffect(() => {
    const term=query.trim().toLocaleLowerCase('fa');
    if(term.length<2){setHits([]);setSearching(false);return;}
    let current=true;
    const timer=window.setTimeout(async()=>{
      setSearching(true);
      const jobs:Promise<SearchHit[]>[]=[];
      if((permissions.machines??0)>=1)jobs.push(api<{id:string;code:string;plate:string;type:string}[]>('/machines').then(items=>items.filter(x=>`${x.code} ${x.plate} ${x.type}`.toLocaleLowerCase('fa').includes(term)).slice(0,6).map(x=>({section:'machines',title:x.code,detail:[x.plate,x.type].filter(Boolean).join(' · ')}))));
      if((permissions.repairs??0)>=1)jobs.push(api<{id:string;number:string;machine_code:string;title:string;shop:string}[]>('/repairs').then(items=>items.filter(x=>`${x.number} ${x.machine_code} ${x.title} ${x.shop}`.toLocaleLowerCase('fa').includes(term)).slice(0,6).map(x=>({section:'repairs',title:`پرونده ${x.number} · ${x.machine_code}`,detail:x.title}))));
      if((permissions.analyses??0)>=1)jobs.push(api<{id:string;machine_code:string;topic:string;cause:string}[]>('/analyses').then(items=>items.filter(x=>`${x.machine_code} ${x.topic} ${x.cause}`.toLocaleLowerCase('fa').includes(term)).slice(0,6).map(x=>({section:'analyses',title:x.topic,detail:x.machine_code}))));
      if((permissions.parts??0)>=1)jobs.push(api<{parts:{id:string;name:string;system:string}[]}>( '/parts').then(data=>data.parts.filter(x=>`${x.name} ${x.system}`.toLocaleLowerCase('fa').includes(term)).slice(0,6).map(x=>({section:'parts',title:x.name,detail:x.system}))));
      const results=(await Promise.allSettled(jobs)).flatMap(result=>result.status==='fulfilled'?result.value:[]).slice(0,12);
      if(current){setHits(results);setSearching(false);}
    },250);
    return()=>{current=false;window.clearTimeout(timer);};
  },[query,permissions]);
  useEffect(()=>{
    function shortcut(event:KeyboardEvent){
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();searchInput.current?.focus();}
      if(event.key==='Escape'){setQuery('');setHits([]);searchInput.current?.blur();}
    }
    window.addEventListener('keydown',shortcut);
    return()=>window.removeEventListener('keydown',shortcut);
  },[]);
  return <div id="app">
    <aside className="sidebar" id="fleet-sidebar">
      <div className="brand">
        <div className="brand-mark"><Icon name="truck" /></div>
        <div className="brand-text"><b>سامانه ناوگان</b><span className="co">{companyName}</span><small>{orgName}</small></div>
      </div>
      <nav className="nav" aria-label="بخش‌های سامانه">
        {groups.map(group => ({ ...group, items: group.items.filter(item => {
          if (item.action === 'repair') return (permissions.repairs ?? 0) >= 2;
          if (item.action === 'analysis') return (permissions.analyses ?? 0) >= 2;
          if (item.action === 'stage') return (permissions.status ?? 0) >= 1;
          if (item.externalHref) return isAdmin;
          if (item.section === 'guide') return true;
          if (item.section === 'users' || item.section === 'migration' || item.section === 'backups') return isAdmin;
          return (permissions[permissionFor[item.section!] ?? ''] ?? 0) >= (item.section === 'settings' || item.section === 'sms' ? 2 : 1);
        }) })).filter(group => group.items.length > 0).map(group => <div className="nav-group" key={group.title}>
          <div className="nav-title">{group.title}</div>
          {group.items.map(item => item.externalHref
            ? <a key={item.externalHref} className="nav-item" href={item.externalHref}><Icon name={item.icon} /><span>{item.label}</span></a>
            : <button key={item.section ?? item.action} className={'nav-item' + (item.section === section ? ' active' : '') + (item.action ? ' accent' : '')}
              aria-pressed={item.section ? item.section === section : undefined}
              onClick={() => { if (item.action === 'repair') onQuickCreate('repairs'); else if (item.action === 'analysis') onQuickCreate('analyses'); else if (item.action === 'stage') onQuickStage(); else if (item.section) navigate(item.section); setOpen(false); }}>
              <Icon name={item.icon} /><span>{item.label}</span>
              {item.badge === 'backup' && backupSummary.tone !== 'good' && <span className="nav-dot warn" title="وضعیت پشتیبان نیازمند بررسی است" aria-hidden="true" />}
              {item.badge && item.badge !== 'backup' && !!sidebarBadges[item.badge] && <span className={`nav-badge ${item.badge === 'maint' || item.badge === 'repairs' && sidebarBadges.repairsLate || item.badge === 'status' && sidebarBadges.statusLate ? 'crit' : 'info'}`} title={item.badge === 'maint' ? 'قطعات گذشته از موعد' : item.badge === 'repairs' ? 'خرابی‌های باز یا دارای تأخیر' : 'ماشین‌های دارای خرابی باز'} aria-hidden="true">{new Intl.NumberFormat('fa-IR').format(sidebarBadges[item.badge]!)}</span>}
            </button>)}
        </div>)}
      </nav>
      <div className="side-foot">
        {isAdmin && <button className={`backup-card tone-${backupSummary.tone}`} aria-label="بازکردن صفحه پشتیبان‌ها" onClick={() => navigate('backups')}><span className="bc-ic"><Icon name={backupSummary.tone === 'good' ? 'shield-check' : 'shield-alert'} /></span><span className="bc-text"><b>{backupSummary.title}</b><small>{backupSummary.subtitle}</small></span></button>}
        <div className="me-card"><span className="avatar">{name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('')}</span><span className="bc-text"><b>{name}</b><small>{isAdmin ? 'مدیر کل' : 'کاربر سامانه'}</small></span><button className="icon-btn sm" aria-label="تغییر رمز من" title="تغییر رمز من" onClick={() => { setPasswordError(''); setPasswordOpen(true); }}><Icon name="key-round" /></button><button className="icon-btn sm" aria-label="خروج" onClick={logout} disabled={pending}><Icon name="log-out" /></button></div>
      </div>
    </aside>
    <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />
    <main className="main">
      <header className="topbar">
        <button className="icon-btn only-mobile" aria-label="منو" aria-controls="fleet-sidebar" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="menu" /></button>
        <div className="search fleet-search">
          <Icon name="search" />
          <input ref={searchInput} value={query} onChange={event=>setQuery(event.target.value)} placeholder="جستجو در خرابی‌ها، ماشین‌ها، قطعات، پرسنل و تحلیل‌ها…" aria-label="جست‌وجوی سراسری" />
          <kbd>Ctrl K</kbd>
          {query.length>=2&&<div className="search-pop open" role="listbox" aria-label="نتیجه‌های جست‌وجو">
            {searching&&<div className="sp-empty">در حال جست‌وجو…</div>}
            {!searching&&!hits.length&&<div className="sp-empty">نتیجه‌ای پیدا نشد.</div>}
            {hits.map((hit,index)=><button type="button" className="sp-item" role="option" key={`${hit.section}-${hit.title}-${index}`} onClick={()=>{navigate(hit.section);setQuery('');setHits([]);}}><span><b>{hit.title}</b><small>{hit.detail}</small></span></button>)}
          </div>}
        </div>
        <div className="top-actions">
          <button className="icon-btn" aria-label="تغییر پوسته" onClick={() => onThemeSettingChange(dark ? 'light' : 'dark')}><Icon name={dark ? 'sun' : 'moon'} /></button>
          {(permissions.analyses??0)>=2&&<button className="btn btn-ghost btn-new" title="ثبت تحلیل جدید" onClick={()=>onQuickCreate('analyses')}><Icon name="clipboard-plus" /><span>تحلیل جدید</span></button>}
          {(permissions.repairs??0)>=2&&<button className="btn btn-primary btn-new" title="اعلام خرابی جدید" onClick={()=>onQuickCreate('repairs')}><Icon name="plus" /><span>اعلام خرابی</span></button>}
        </div>
      </header>
      <div className="view">{children}</div>
    </main>
    {passwordNotice && <div className="toasts" role="status"><div className="toast toast-ok in"><Icon name="circle-check" />{passwordNotice}</div></div>}
    {passwordOpen && <div className="modal-wrap in" onMouseDown={event => { if (event.target === event.currentTarget && !passwordBusy) setPasswordOpen(false); }}>
      <div className="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
        <div className="modal-head"><span className="modal-ic"><Icon name="key-round" /></span><h3 id="change-password-title">تغییر رمز من</h3><button className="icon-btn sm" type="button" aria-label="بستن" disabled={passwordBusy} onClick={() => setPasswordOpen(false)}><Icon name="x" /></button></div>
        <form onSubmit={changePassword} autoComplete="off">
          <div className="modal-body form-grid cols-1">
            <label>رمز فعلی<input className="input" type="password" name="currentPassword" autoComplete="current-password" required maxLength={256} /></label>
            <label>رمز جدید<input className="input" type="password" name="password" autoComplete="new-password" required minLength={12} maxLength={256} placeholder="دست‌کم ۱۲ نویسه" /></label>
            <label>تکرار رمز جدید<input className="input" type="password" name="confirmPassword" autoComplete="new-password" required minLength={12} maxLength={256} /></label>
            {passwordError && <p role="alert" className="notice notice-warn">{passwordError}</p>}
          </div>
          <div className="modal-foot"><button className="btn btn-ghost" type="button" disabled={passwordBusy} onClick={() => setPasswordOpen(false)}>انصراف</button><button className="btn btn-primary" disabled={passwordBusy}><Icon name="save" />{passwordBusy ? 'در حال ذخیره…' : 'ذخیره رمز'}</button></div>
        </form>
      </div>
    </div>}
  </div>;
}
