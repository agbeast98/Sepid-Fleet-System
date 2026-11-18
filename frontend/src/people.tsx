import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { api, errorMessage } from './api';
import { Icon } from './shell';

type Person={id:string;name:string;role:'driver'|'supervisor'|'pm'|'other';phone?:string;note?:string;active:boolean;version?:number;machine_codes?:string[]};
type Draft={name:string;role:Person['role'];phone:string;note:string;active:boolean};
const roles:Record<Person['role'],string>={driver:'راننده',supervisor:'سرپرست',pm:'مسئول نگهداری',other:'سایر پرسنل'};
const groups:{role:Person['role'];label:string}[]=[{role:'driver',label:'رانندگان'},{role:'supervisor',label:'سرپرستان'},{role:'pm',label:'مسئولین PM'},{role:'other',label:'سایر'}];
const empty:Draft={name:'',role:'driver',phone:'',note:'',active:true};
function personInitials(name:string){const parts=String(name||'?').trim().split(/\s+/);return `${(parts[0]||'?')[0]}${parts.length>1?`‌${parts[parts.length-1][0]}`:''}`;}
function personHue(name:string){let hue=0;for(const character of String(name))hue=(hue*31+character.charCodeAt(0))%360;return hue;}

export function People({level,availableSections,canManageDefinitions,onNavigate}:{level:number;availableSections:('machines'|'people')[];canManageDefinitions:boolean;onNavigate:(section:'settings'|'machines'|'people')=>void}){
  const [items,setItems]=useState<Person[]>([]);
  const [draft,setDraft]=useState<Draft>(empty);
  const [editing,setEditing]=useState<Person|null>(null);
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');

  async function refresh(){setBusy(true);setError('');try{setItems(await api<Person[]>('/people'));}catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}}
  useEffect(()=>{void refresh();},[]);
  function edit(person?:Person){setEditing(person??null);setDraft(person?{name:person.name,role:person.role,phone:person.phone??'',note:person.note??'',active:person.active}:{...empty});setOpen(true);setError('');setStatus('');}
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(level<2)return;
    setBusy(true);setError('');setStatus('');
    try{
      if(editing)await api(`/people/${encodeURIComponent(editing.id)}`,'PATCH',{name:draft.name,phone:draft.phone,note:draft.note,active:draft.active,version:editing.version});
      else await api('/people','POST',draft);
      setOpen(false);setStatus(editing?'اطلاعات پرسنل ذخیره شد.':'پرسنل جدید ثبت شد.');await refresh();
    }catch(failure){setError(failure instanceof Error&&'status'in failure&&failure.status===409?'اطلاعات این فرد هم‌زمان تغییر کرده است؛ فهرست را تازه کنید.':errorMessage(failure));setBusy(false);}
  }
  const ordered=items.slice().sort((a,b)=>{
      const aSeed=/^p(\d+)$/.exec(a.id),bSeed=/^p(\d+)$/.exec(b.id);
      if(aSeed&&bSeed)return Number(aSeed[1])-Number(bSeed[1]);
      if(aSeed)return -1;if(bSeed)return 1;
      return a.name.localeCompare(b.name,'fa');
    });

  return <section className="page">
    <header className="page-head"><div className="ph-text"><div className="settings-breadcrumb"><span>تنظیمات و تعاریف</span><span aria-hidden="true">‹</span><span>پرسنل</span></div><h1>تنظیمات و تعاریف</h1><p>رانندگان، سرپرستان و مسئولان PM؛ سمت هر فرد را در فرم تعریف انتخاب کنید.</p></div><div className="ph-actions">{level>=2&&<button className="btn btn-primary" disabled={busy} onClick={()=>edit()}><Icon name="user-plus"/>تعریف فرد جدید</button>}</div></header>
    <nav className="set-tabs settings-tabs" aria-label="زبانه‌های تنظیمات" role="tablist">
      <button type="button" role="tab" aria-selected="false" onClick={()=>onNavigate('settings')}><Icon name="sliders"/><span>عمومی</span></button>
      {availableSections.includes('machines')&&<button type="button" role="tab" aria-selected="false" onClick={()=>onNavigate('machines')}><Icon name="truck"/><span>ماشین‌ها</span></button>}
      {availableSections.includes('people')&&<button type="button" role="tab" aria-selected="true" className="on" onClick={()=>onNavigate('people')}><Icon name="users"/><span>پرسنل (راننده، سرپرست، PM)</span></button>}
      {canManageDefinitions&&<><button type="button" role="tab" aria-selected="false" onClick={()=>{sessionStorage.setItem('sepid-directory-focus','model');onNavigate('machines');}}><Icon name="layers"/><span>مدل‌ها</span></button><button type="button" role="tab" aria-selected="false" onClick={()=>{sessionStorage.setItem('sepid-settings-tab','stages');onNavigate('settings');}}><Icon name="route"/><span>مراحل وضعیت</span></button><button type="button" role="tab" aria-selected="false" onClick={()=>{sessionStorage.setItem('sepid-settings-tab','rules');onNavigate('settings');}}><Icon name="gavel"/><span>قوانین اقدامات مدیریتی</span></button></>}
    </nav>
    <div className="people-settings-page">
    {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
    {open&&<form className="record" onSubmit={save}>
      <h3>{editing?'ویرایش پرسنل':'پرسنل جدید'}</h3>
      <div className="fields">
        <label>نام پرسنل<input required maxLength={150} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
        <label>نقش<select aria-label="نقش پرسنل" value={draft.role} disabled={!!editing} onChange={event=>setDraft({...draft,role:event.target.value as Person['role']})}>{Object.entries(roles).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>تلفن<input type="tel" maxLength={40} value={draft.phone} onChange={event=>setDraft({...draft,phone:event.target.value})}/></label>
        <label>توضیحات پرسنل<textarea maxLength={4000} value={draft.note} onChange={event=>setDraft({...draft,note:event.target.value})}/></label>
        {!!editing&&<label className="check"><input type="checkbox" checked={draft.active} onChange={event=>setDraft({...draft,active:event.target.checked})}/>پرسنل فعال</label>}
      </div>
      <div className="toolbar"><button disabled={busy}>ذخیره اطلاعات پایه</button><button type="button" disabled={busy} onClick={()=>setOpen(false)}>انصراف</button></div>
    </form>}
    {items.length>0&&<>
      {items.length?groups.map(group=>{
        const members=ordered.filter(person=>person.role===group.role);
        return members.length?<section className="card flush people-directory-group" key={group.role}>
          <div className="card-head pad"><h3>{group.label}</h3><span className="count">{new Intl.NumberFormat('fa-IR').format(members.length)} نفر</span></div>
          <div className="table-wrap"><table className="table def-table"><thead><tr><th>نام</th>{level>=2&&<th>تلفن</th>}<th>ماشین‌ها</th><th>وضعیت</th>{level>=2&&<th></th>}</tr></thead><tbody>{members.map(person=><tr key={person.id} className="row-link">
            <td><span className="u-cell"><i className="avatar" style={{'--h':personHue(person.name)} as CSSProperties} aria-hidden="true">{personInitials(person.name)}</i><b>{person.name}</b></span></td>{level>=2&&<td dir="ltr" style={{textAlign:'right'}}>{person.phone||<span className="muted">—</span>}</td>}<td>{person.machine_codes?.length?<span className="people-machine-tags">{person.machine_codes.map(code=><i className="mtag" key={code}>{code}</i>)}</span>:<span className="muted">—</span>}</td><td>{person.active?<span className="st st-good">فعال</span>:<span className="st st-muted">غیرفعال</span>}</td>{level>=2&&<td><button disabled={busy} onClick={()=>edit(person)}><Icon name="pencil"/>ویرایش</button></td>}
          </tr>)}</tbody></table></div>
        </section>:null;
      }):null}
    </>}
    {!items.length&&!busy&&!error&&<p>پرسنلی ثبت نشده است.</p>}
    </div>
  </section>;
}
