import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { api, errorMessage } from './api';
import { Icon } from './shell';

const permissions = [
  ['dashboard', 'داشبورد', 1], ['status', 'وضعیت ماشین‌ها', 3], ['repairs', 'تعمیرات', 3],
  ['machines', 'ماشین‌آلات', 3], ['people', 'پرسنل', 3], ['maint', 'نگهداری', 3],
  ['parts', 'قطعات', 3], ['settings', 'تنظیمات', 2], ['analyses', 'تحلیل خرابی', 3], ['sms', 'پیامک', 2],
] as const;
type StageDefinition={id:string;label:string;kind:'report'|'step'|'test'};
type Person={id:string;name:string;role:string;active:boolean};
type User = { id: string; name: string; username: string; active: boolean; is_super_admin: boolean; phone: string; receive_sms: boolean; person_id:string|null; scope_shop:boolean; permissions: Record<string, number>; stages: string[];last_login:string|null };
type Draft = Omit<User, 'id' | 'is_super_admin' | 'last_login'> & { password: string; template:string };
const roleTemplates:Record<string,{label:string;permissions:Record<string,number>;stages:string[];scope_shop:boolean}>={
  supervisor:{label:'سرپرست',permissions:{status:2,repairs:2,dashboard:1,analyses:2,people:1,machines:1,maint:1,parts:1,settings:0,sms:0},stages:['report','dispatch','wait','test'],scope_shop:false},
  repair:{label:'تعمیرات',permissions:{status:2,repairs:1,dashboard:0,analyses:0,people:0,machines:1,maint:1,parts:1,settings:0,sms:0},stages:['dispatch','wait','done'],scope_shop:true},
  tester:{label:'مسئول تست سلامت',permissions:{status:2,repairs:1,dashboard:1,analyses:0,people:0,machines:1,maint:1,parts:1,settings:0,sms:0},stages:['test'],scope_shop:false},
  viewer:{label:'فقط مشاهده',permissions:{status:1,repairs:1,dashboard:1,analyses:1,people:1,machines:1,maint:1,parts:1,settings:0,sms:0},stages:[],scope_shop:false},
};
const emptyDraft: Draft = { name: '', username: '', active: true, phone: '', receive_sms: false, person_id:null, scope_shop:false, permissions: {}, stages: [], password: '',template:'' };

export function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [currentUserId,setCurrentUserId]=useState('');
  const [stages,setStages]=useState<StageDefinition[]>([]);
  const [people,setPeople]=useState<Person[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  async function refresh() {
    setBusy(true); setError('');
    try { const [accounts,configured,people,current]=await Promise.all([api<User[]>('/users'),api<StageDefinition[]>('/repairs/stages'),api<Person[]>('/people'),api<{id:string}>('/auth/me')]);setUsers(accounts);setStages(configured);setPeople(people);setCurrentUserId(current.id); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if(!status)return;const timer=window.setTimeout(()=>setStatus(''),3500);return()=>window.clearTimeout(timer); },[status]);
  useEffect(() => {
    if (!open) return;
    document.body.classList.add('has-modal');
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => { document.body.classList.remove('has-modal'); window.removeEventListener('keydown', closeOnEscape); };
  }, [open, busy]);
  function templateFor(user:Pick<User,'permissions'|'stages'|'scope_shop'>):string{
    const stageSet=[...user.stages].sort().join('|');
    return Object.entries(roleTemplates).find(([,template])=>
      template.scope_shop===user.scope_shop
      &&[...template.stages].sort().join('|')===stageSet
      &&permissions.every(([key])=>(user.permissions[key]??0)===(template.permissions[key]??0))
    )?.[0]??'';
  }
  function edit(user?: User) {
    setEditing(user ?? null);
    setDraft(user
      ? { name: user.name, username: user.username, active: user.active, phone: user.phone, receive_sms: user.receive_sms, person_id:user.person_id, scope_shop:user.scope_shop, permissions: user.permissions, stages: user.stages, password: '',template:templateFor(user) }
      : { ...emptyDraft });
    setOpen(true); setError(''); setStatus('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(editing ? `/users/${editing.id}` : '/users', editing ? 'PATCH' : 'POST', draft);
      setOpen(false); setStatus(editing ? 'تغییرات کاربر ذخیره شد.' : 'کاربر جدید ساخته شد.');
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error && 'status' in failure && failure.status === 409
        ? 'این نام کاربری قبلاً ثبت شده است.' : errorMessage(failure));
    } finally { setBusy(false); }
  }
  function applyTemplate(key:string){
    const template=roleTemplates[key];
    if(!template){setDraft({...draft,template:''});return;}
    setDraft({...draft,template:key,permissions:template.permissions,stages:template.stages.filter(stage=>stages.some(item=>item.id===stage)),scope_shop:template.scope_shop});
  }
  return <section className="page users-page">
    <header className="page-head"><div className="ph-text"><h1>کاربران و دسترسی‌ها</h1><p>هر نفر نام کاربری و رمز جدا دارد و فقط بخش‌هایی را می‌بیند که به او داده شده</p></div><div className="ph-actions">
      <button className="btn btn-primary" disabled={busy} onClick={() => edit()}><Icon name="user-plus"/> کاربر جدید</button>
    </div></header>
    {!open && error && <p role="alert">{error}</p>}{status && <div className="toasts" role="status"><div className="toast toast-ok in"><Icon name="circle-check"/>{status}</div></div>}
    {open && <div className="modal-wrap in user-editor-wrap" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)setOpen(false);}}>
      <section className="modal modal-lg user-editor-modal" role="dialog" aria-modal="true" aria-labelledby="user-editor-title" aria-describedby="user-editor-description">
        <header className="modal-head"><span className="modal-ic"><Icon name={editing?'pencil':'user-plus'}/></span><div className="user-modal-title"><h3 id="user-editor-title">{editing?'ویرایش کاربر':'افزودن کاربر جدید'}</h3><p id="user-editor-description">اطلاعات حساب و سطح دسترسی این کاربر را تنظیم کنید.</p></div><button className="icon-btn sm" type="button" aria-label="بستن" disabled={busy} onClick={()=>setOpen(false)}><Icon name="x"/></button></header>
        <form className="user-editor-form" onSubmit={save} autoComplete="off">
          <div className="modal-body user-editor-body">
            {error&&<p role="alert" className="user-modal-error">{error}</p>}
            <section className="user-editor-section"><div className="user-section-head"><h4>اطلاعات حساب</h4><p>نام و روش ورود کاربر را مشخص کنید.</p></div><div className="fields user-account-fields">
              <label>نام نمایشی<input autoFocus required maxLength={150} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} /></label>
              <label>نام کاربری<input required minLength={3} maxLength={100} pattern={String.raw`[A-Za-z0-9._\-]+`} title="فقط حروف انگلیسی، عدد، نقطه، خط تیره و زیرخط؛ حداقل ۳ نویسه" dir="ltr" autoComplete="off" value={draft.username} onChange={e=>setDraft({...draft,username:e.target.value})} /><small className="muted">حداقل ۳ نویسه؛ حروف انگلیسی، عدد، نقطه، خط تیره یا زیرخط.</small></label>
              <label>رمز عبور{editing?' جدید (اختیاری)':''}<input type="password" autoComplete="new-password" minLength={12} maxLength={256} required={!editing} placeholder={editing?'برای حفظ رمز فعلی خالی بگذارید':'حداقل ۱۲ نویسه'} value={draft.password} onChange={e=>setDraft({...draft,password:e.target.value})}/></label>
              <label>موبایل برای پیامک<input type="tel" inputMode="tel" dir="ltr" maxLength={30} required={draft.receive_sms} placeholder="0912…" aria-describedby="user-phone-help" value={draft.phone} onChange={e=>setDraft({...draft,phone:e.target.value})}/><small id="user-phone-help" className="muted">برای پیامک، شمارهٔ موبایل معتبر ایران وارد کنید.</small></label>
              <label>اتصال به پروندهٔ پرسنلی<select value={draft.person_id??''} onChange={e=>setDraft({...draft,person_id:e.target.value||null})}><option value="">بدون اتصال</option>{people.filter(person=>person.role!=='driver'&&(person.active||person.id===draft.person_id)).map(person=><option key={person.id} value={person.id}>{person.name} ({person.role==='supervisor'?'سرپرست':person.role==='pm'?'مسئول PM':'سایر پرسنل'})</option>)}</select><small className="muted">برای انتخاب گیرندهٔ پیامک سرپرست یا مسئول PM.</small></label>
              <div className="user-account-toggles"><label className="check"><input type="checkbox" checked={draft.active} onChange={e=>setDraft({...draft,active:e.target.checked})}/>حساب فعال</label><label className="check"><input type="checkbox" checked={draft.receive_sms} onChange={e=>setDraft({...draft,receive_sms:e.target.checked})}/>دریافت پیامک تغییر مراحل</label></div>
            </div></section>
            <section className="user-editor-section"><div className="user-section-head"><h4>نقش و دسترسی</h4><p>الگوی آماده انتخاب کنید یا دسترسی هر بخش را جداگانه تغییر دهید.</p></div>
              <label className="user-template-field">الگوی دسترسی<select aria-label="الگوی دسترسی" value={draft.template} onChange={event=>applyTemplate(event.target.value)}><option value="">دسترسی سفارشی</option>{Object.entries(roleTemplates).map(([key,item])=><option key={key} value={key}>{item.label}</option>)}</select></label>
              <div className="fields user-permission-grid">{permissions.map(([key,label,max])=><label key={key}>{label}<select value={draft.permissions[key]??0} onChange={e=>setDraft({...draft,template:'',permissions:{...draft.permissions,[key]:Number(e.target.value)}})}>{['بدون دسترسی','مشاهده','ثبت و ویرایش','حذف'].slice(0,max+1).map((name,value)=><option key={value} value={value}>{name}</option>)}</select></label>)}</div>
              <div className="user-access-preview"><b>{draft.template?roleTemplates[draft.template]?.label:'دسترسی سفارشی'}</b><span>{new Intl.NumberFormat('fa-IR').format(Object.values(draft.permissions).filter(level=>level>0).length)} بخش دارای دسترسی</span><span>{draft.stages.map(id=>stages.find(stage=>stage.id===id)?.label??id).join('، ')||'مرحلهٔ خاصی انتخاب نشده'}</span><small>{draft.scope_shop?'پرونده‌های در حال تعمیر را می‌بیند؛ این محدودیت بر اساس مرحلهٔ جاری پرونده اعمال می‌شود.':'محدودهٔ پرونده بر اساس مجوزهای بخش تعیین می‌شود.'}</small></div>
              <h4 className="user-subhead">مراحل مجاز</h4><p className="muted small">برای ثبت مرحله، سطح «ثبت و ویرایش» در بخش «وضعیت ماشین‌ها» نیز لازم است.</p><div className="user-stage-grid">{stages.map(stage=><label className="check" key={stage.id}><input type="checkbox" checked={draft.stages.includes(stage.id)} onChange={e=>setDraft({...draft,template:'',stages:e.target.checked?[...new Set([...draft.stages,stage.id])]:draft.stages.filter(item=>item!==stage.id)})}/>{stage.label}</label>)}</div>
              <label className="check user-scope-check"><input type="checkbox" checked={draft.scope_shop} onChange={event=>setDraft({...draft,template:'',scope_shop:event.target.checked})}/>محدودکردن فهرست و سوابق به پرونده‌های در حال تعمیر</label>
            </section>
          </div>
          <footer className="modal-foot"><button className="btn btn-ghost" type="button" disabled={busy} onClick={()=>setOpen(false)}>انصراف</button><button className="btn btn-primary" disabled={busy}><Icon name="save"/>{busy?'در حال ذخیره…':editing?'ذخیره تغییرات':'ساخت کاربر'}</button></footer>
        </form>
      </section>
    </div>}
    {!users.length&&!busy&&<p>کاربری پیدا نشد.</p>}
    {!!users.length&&<>
      <div className="notice notice-warn"><Icon name="shield"/><span>فقط <b>{users.find(user=>user.is_super_admin)?.name??'مدیر کل'}</b> کاربر می‌سازد، رمز تعیین می‌کند و دسترسی می‌دهد. دسترسی خودِ او همیشه کامل است و قابل کم کردن نیست.</span></div>
      <section className="card flush"><div className="table-wrap"><table><thead><tr><th>نام</th><th>نام کاربری</th><th>نقش</th><th>دسترسی</th><th>موبایل</th><th>وضعیت</th><th>آخرین ورود</th><th aria-label="عملیات"/></tr></thead>
      <tbody>{users.map(user=>{const initials=(()=>{const parts=String(user.name||'?').trim().split(/\s+/);return `${(parts[0]||'?')[0]}${parts.length>1?`‌${parts[parts.length-1][0]}`:''}`;})();let hue=0;for(const character of String(user.name))hue=(hue*31+character.charCodeAt(0))%360;const accessCount=Object.values(user.permissions??{}).filter(level=>level>0).length;const lastLogin=user.last_login?new Intl.DateTimeFormat('fa-IR',{dateStyle:'short',timeStyle:'short'}).format(new Date(user.last_login)):'—';return <tr key={user.id}><td><span className="u-cell"><i className="avatar" style={{'--h':hue} as CSSProperties} aria-hidden="true">{initials}</i><span><b>{user.name}</b>{user.id===currentUserId&&<small>شما</small>}</span></span></td><td dir="ltr" style={{textAlign:'right'}}>{user.username||'—'}</td>
        <td>{user.is_super_admin?'مدیر کل':roleTemplates[templateFor(user)]?.label??'سفارشی'}</td><td>{user.is_super_admin?'همه بخش‌ها':accessCount?`${new Intl.NumberFormat('fa-IR').format(accessCount)} بخش`:'بدون دسترسی'}</td>
        <td dir="ltr" style={{textAlign:'right'}}>{user.phone||<span className="muted">—</span>}</td><td>{user.active?<span className="st st-good">فعال</span>:<span className="st st-muted">غیرفعال</span>}</td><td className="muted">{lastLogin}</td><td>{user.is_super_admin?<span className="lock-tag"><Icon name="lock"/>دسترسی کامل · قابل تغییر نیست</span>:<button className="link" disabled={busy} onClick={()=>edit(user)}>ویرایش دسترسی <Icon name="chevron-left"/></button>}</td>
      </tr>})}</tbody></table></div><div className="table-foot">{new Intl.NumberFormat('fa-IR').format(users.length)} کاربر</div></section>
      <section className="card"><div className="card-head"><h3><Icon name="info"/> سطح‌های دسترسی</h3></div><div className="lv-help">
        <div><b>بدون دسترسی</b><span>آن بخش در منو دیده نمی‌شود.</span></div>
        <div><b>مشاهده</b><span>فقط می‌بیند؛ دکمه‌های ثبت و ویرایش برایش نیست.</span></div>
        <div><b>ثبت و ویرایش</b><span>می‌تواند ثبت و ویرایش کند ولی چیزی را حذف نمی‌کند.</span></div>
        <div><b>حذف هم</b><span>علاوه بر ثبت و ویرایش، می‌تواند حذف کند.</span></div>
      </div></section>
    </>}
  </section>;
}
