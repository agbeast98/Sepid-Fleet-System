import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, ApiError, errorMessage } from './api';
import { Icon } from './shell';

type Person = { id:string; name:string; role:'driver'|'pm'|'supervisor'|'other'; active:boolean };
type Machine = { id:string; code:string; plate:string|null; driver_id:string|null; pm_id:string|null; supervisor_id:string|null };
type Rule = { min:number; max:number|null; action:string };
type Rules = Record<'driver'|'pm', Record<'low'|'mid'|'high', Rule[]>>;
type Options = { people:{id:string;name:string;role:string}[]; rules:Rules; countWindow:'all'|'year'|'12m' };
type Analysis = { id:string; machine_id:string; machine_code:string; analysis_date:string; created_at:string; topic:string; severity:string; cause:string; note:string; responses:Record<string,unknown> };
type Role = 'driver'|'pm';
type Finding = { analysis:Analysis; role:Role; occurrence:number; action:string };
const fa = new Intl.NumberFormat('fa-IR');
const severityOrder = ['low','mid','high'] as const;
const severityLabel:Record<string,string>={low:'کم‌اهمیت',mid:'نیمه‌حساس',high:'خیلی حساس'};
const roleLabel:Record<string,string>={driver:'راننده',pm:'مسئول PM',supervisor:'سرپرست',other:'سایر پرسنل'};
const resultLabel=(item:Analysis)=>{
  const r=item.responses??{};const driver=r.q1==='yes'&&r.q1b==='no';const pm=r.q2==='yes'&&r.q2b==='no';
  return driver&&pm?'سهل‌انگاری مشترک':driver?'سهل‌انگاری راننده':pm?'سهل‌انگاری مسئول PM':'بدون سهل‌انگاری';
};
const dateKey=(value:string)=>value.slice(0,10);
const normalize=(value:unknown)=>typeof value==='string'?value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('fa'):'';
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function avatar(name:string, size:'sm'|'lg'='sm'){
  const parts=name.trim().split(/\s+/);const initials=`${parts[0]?.[0]??'?'}${parts.length>1?`‌${parts.at(-1)?.[0]??''}`:''}`;
  const hue=[...name].reduce((value,char)=>(value*31+char.charCodeAt(0))%360,0);
  return <span className={`avatar ${size==='lg'?'xl':'lg'}`} style={{'--h':hue} as CSSProperties}>{initials}</span>;
}
const persianYear=new Intl.DateTimeFormat('en-US-u-ca-persian',{year:'numeric',timeZone:'Asia/Tehran'});
const dateFmt=new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium',timeZone:'UTC'});
function severityKey(value:string){return value==='medium'?'mid':value;}
function withinWindow(date:string,window:'all'|'year'|'12m',reference=today){
  if(window==='all')return true;
  const d=new Date(`${dateKey(date)}T12:00:00Z`),ref=new Date(`${reference}T12:00:00Z`);
  if(Number.isNaN(d.valueOf())||Number.isNaN(ref.valueOf())||d>ref)return false;
  if(window==='year')return persianYear.format(d)===persianYear.format(ref);
  const days=Math.floor((ref.valueOf()-d.valueOf())/86400000);return days>=0&&days<=365;
}
function actionFor(ruleRows:Rule[],count:number){return ruleRows.find(rule=>count>=rule.min&&(rule.max==null||count<=rule.max))?.action??'';}
function actionTone(action:string){return action.includes('حقوق')?'crit':action.includes('پاداش')?'serious':'warn';}
function actionIcon(action:string){return actionTone(action)==='crit'?'octagon-alert':actionTone(action)==='serious'?'triangle-alert':'file-pen-line';}
function legacyPersonOrder(person:Person){const match=/^p(\d+)$/.exec(person.id);return match?Number(match[1]):Number.MAX_SAFE_INTEGER;}

export function ManagementActions({permissions,initialPersonId,onSelectPerson,onNavigate}:{permissions:Record<string,number>;initialPersonId:string|null;onSelectPerson:(id:string|null)=>void;onNavigate:(section:'settings'|'analyses'|'people')=>void}){
  const [people,setPeople]=useState<Person[]>([]);const [machines,setMachines]=useState<Machine[]>([]);const [analyses,setAnalyses]=useState<Analysis[]>([]);const [options,setOptions]=useState<Options|null>(null);
  const [busy,setBusy]=useState(true);const [error,setError]=useState('');
  const canAnalyze=(permissions.analyses??0)>=1;const canSeeMachines=(permissions.machines??0)>=1;
  async function refresh(){
    setBusy(true);setError('');
    try{
      const tasks:[Promise<Person[]>,Promise<Analysis[]|null>,Promise<Options|null>,Promise<Machine[]|null>]=[
        api<Person[]>('/people'),
        canAnalyze?api<Analysis[]>('/analyses'):Promise.resolve(null),
        canAnalyze?api<Options>('/analyses/options'):Promise.resolve(null),
        canSeeMachines?api<Machine[]>('/machines'):Promise.resolve(null),
      ];
      const results=await Promise.allSettled(tasks);
      const [p,a,o,m]=results;
      if(p.status==='rejected')throw p.reason;
      setPeople(p.value);setAnalyses(a.status==='fulfilled'?a.value??[]:[]);setOptions(o.status==='fulfilled'?o.value:null);setMachines(m.status==='fulfilled'?m.value??[]:[]);
      if((a.status==='rejected'||o.status==='rejected')&&canAnalyze)setError('اطلاعات تحلیل‌ها بارگیری نشد؛ صفحه را تازه کنید.');
      else if(m.status==='rejected'&&canSeeMachines)setError('تخصیص خودروها بارگیری نشد؛ شمار خودروها ممکن است ناقص باشد.');
    }catch(failure){setError(errorMessage(failure));setPeople([]);setAnalyses([]);setOptions(null);setMachines([]);}
    finally{setBusy(false);}
  }
  useEffect(()=>{void refresh();},[canAnalyze,canSeeMachines]);
  useEffect(()=>{if(initialPersonId&&!people.some(person=>person.id===initialPersonId))onSelectPerson(null);},[initialPersonId,people]);

  const shownPeople=[...people].sort((a,b)=>legacyPersonOrder(a)-legacyPersonOrder(b)||a.name.localeCompare(b.name,'fa'));
  const isPersonFor=(analysis:Analysis,person:Person,role:Role)=>{
    const key=role==='driver'?'driver_id':'pm_id';const nameKey=role==='driver'?'driver_name':'pm_name';const response=analysis.responses??{};
    if(response[key]===person.id)return true;
    return role==='driver'&&!response.driver_id&&normalize(response[nameKey])===normalize(person.name);
  };
  function findingsFor(person:Person,role:Role):Finding[]{
    if(!canAnalyze||!options)return [];
    const source=analyses.filter(item=>isPersonFor(item,person,role)&&((role==='driver'&&item.responses.q1==='yes'&&item.responses.q1b==='no')||(role==='pm'&&item.responses.q2==='yes'&&item.responses.q2b==='no')))
      .filter(item=>severityOrder.includes(severityKey(item.severity) as typeof severityOrder[number]))
      .sort((a,b)=>dateKey(a.analysis_date).localeCompare(dateKey(b.analysis_date))||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
    return source.map(item=>{
      const severity=severityKey(item.severity) as typeof severityOrder[number];
      const occurrence=source.filter(candidate=>severityKey(candidate.severity)===severity&&
        (dateKey(candidate.analysis_date)<dateKey(item.analysis_date)||(dateKey(candidate.analysis_date)===dateKey(item.analysis_date)&&candidate.created_at<=item.created_at))&&
        withinWindow(candidate.analysis_date,options.countWindow,dateKey(item.analysis_date))).length;
      return {analysis:item,role,occurrence,action:actionFor(options.rules?.[role]?.[severity]??[],occurrence)};
    });
  }
  function summary(person:Person,role:Role){
    const rows=severityOrder.map(severity=>{
      const findings=findingsFor(person,role).filter(item=>severityKey(item.analysis.severity)===severity&&withinWindow(item.analysis.analysis_date,options?.countWindow??'all'));
      return {severity,count:findings.length,action:actionFor(options?.rules?.[role]?.[severity]??[],findings.length)};
    });
    return rows;
  }
  function machinesFor(person:Person){return machines.filter(machine=>machine.driver_id===person.id||machine.pm_id===person.id||machine.supervisor_id===person.id);}
  const groups=[['driver','رانندگان'],['pm','مسئولین PM'],['supervisor','سرپرستان']] as const;
  const selected=people.find(person=>person.id===initialPersonId)??null;
  const details=useMemo(()=>selected&&canAnalyze?(['driver','pm'] as Role[]).flatMap(role=>findingsFor(selected,role)).sort((a,b)=>dateKey(b.analysis.analysis_date).localeCompare(dateKey(a.analysis.analysis_date))||b.analysis.created_at.localeCompare(a.analysis.created_at)):[],[selected,analyses,options,canAnalyze]);
  return <section className="page">
    <header className="page-head"><div className="ph-text"><h1>{selected?selected.name:'اقدامات مدیریتی'}</h1><p>{selected?roleLabel[selected.role]??'پرسنل':'تعداد دفعات سهل‌انگاری هر نفر به تفکیک سطح حساسیت و اقدام مدیریتی متناسب با آن'}</p></div><div className="ph-actions">
      {selected&&<button type="button" className="btn btn-ghost" onClick={()=>onSelectPerson(null)}><Icon name="arrow-right"/>بازگشت به فهرست</button>}
      {!selected&&(permissions.people??0)>=2&&<button type="button" className="btn btn-ghost" onClick={()=>onNavigate('people')}><Icon name="settings"/>تعریف و ویرایش پرسنل</button>}
    </div></header>
    <div className="management-actions-page">
    {error&&<p role="alert" className="notice notice-warn">{error}</p>}
    {!canAnalyze&&<p className="notice notice-info">برای دیدن شمارش سهل‌انگاری و اقدام‌های جاری، مجوز مشاهدهٔ تحلیل‌ها لازم است. اطلاعات پرسنل طبق سطح دسترسی شما نمایش داده می‌شود.</p>}
    {busy?<p role="status">در حال دریافت اطلاعات…</p>:selected?<>
      <div className="management-detail-grid">
        <div className="stack">
          {!canAnalyze?<section className="card calm"><Icon name="shield-check"/> برای مشاهدهٔ شمارش‌ها و سوابق، مجوز تحلیل خرابی لازم است.</section>:selected.role==='supervisor'?<section className="card calm"><Icon name="shield-check"/> برای سرپرست شمارش سهل‌انگاری انجام نمی‌شود.</section>:(['driver','pm'] as Role[]).filter(role=>role===(selected.role==='pm'?'pm':'driver')||details.some(item=>item.role===role)).map(role=>{
            const rows=summary(selected,role);const list=details.filter(item=>item.role===role);
            return <section className="card" key={role}><div className="card-head"><h3>اقدام‌های {role==='driver'?'راننده':'مسئول PM'}</h3><span className="muted small">{fa.format(list.length)} سابقه</span></div>
              <div className="table-wrap"><table><thead><tr><th>حساسیت</th><th>تعداد در بازه</th><th>اقدام جاری</th></tr></thead><tbody>{rows.map(row=><tr className={!row.count?'dim':''} key={row.severity}><td><span className={`sev sev-${row.severity}`}><i/>{severityLabel[row.severity]}</span></td><td>{fa.format(row.count)}</td><td>{row.action?<span className="state-pill" data-action-tone={actionTone(row.action)}>{row.action}</span>:'—'}</td></tr>)}</tbody></table></div>
              <h4 className="sub-title">سوابق سهل‌انگاری</h4>{list.length?<ol className="management-timeline">{list.map(finding=><li key={finding.analysis.id}><span className={`management-dot sev-${severityKey(finding.analysis.severity)}`}/><div><b>{finding.analysis.topic}</b><small>{dateFmt.format(new Date(dateKey(finding.analysis.analysis_date)+'T12:00:00Z'))} · {finding.analysis.machine_code} · {severityLabel[severityKey(finding.analysis.severity)]} · بار {fa.format(finding.occurrence)}</small><small>{resultLabel(finding.analysis)}{finding.analysis.cause?` · علت: ${finding.analysis.cause}`:''}</small></div>{finding.action&&<span className="state-pill" data-action-tone={actionTone(finding.action)}>{finding.action}</span>}</li>)}</ol>:<p className="calm"><Icon name="shield-check"/> هیچ سهل‌انگاری برای این فرد ثبت نشده است.</p>}
            </section>;
          })}
          {selected.role==='supervisor'&&<section className="card"><div className="card-head"><h3>سوابق مرتبط</h3></div>{details.length?<ol className="management-timeline">{details.map(item=><li key={`${item.analysis.id}-${item.role}`}><span className={`management-dot sev-${severityKey(item.analysis.severity)}`}/><div><b>{item.analysis.topic}</b><small>{dateFmt.format(new Date(dateKey(item.analysis.analysis_date)+'T12:00:00Z'))} · {item.analysis.machine_code} · {roleLabel[item.role]}</small></div></li>)}</ol>:<p className="calm">برای سرپرست شمارش سهل‌انگاری انجام نمی‌شود.</p>}</section>}
        </div>
        <aside className="stack"><section className="card management-profile">{avatar(selected.name,'lg')}<h3>{selected.name}</h3><span className="muted">{roleLabel[selected.role]??'پرسنل'}{!selected.active?' · غیرفعال':''}</span></section>
          <section className="card"><div className="card-head"><h3>خودروهای مرتبط</h3><span className="muted small">{canSeeMachines?fa.format(machinesFor(selected).length):'—'}</span></div>{canSeeMachines?machinesFor(selected).length?<ul className="mini-list">{machinesFor(selected).map(machine=><li key={machine.id}><span><b>{machine.code}</b><small>{machine.driver_id===selected.id?'راننده':machine.pm_id===selected.id?'مسئول PM':'سرپرست'}</small></span><span className="muted">{machine.plate||'بدون پلاک'}</span></li>)}</ul>:<p className="calm">به خودرویی تخصیص داده نشده است.</p>:<p className="calm">برای دیدن خودروهای مرتبط، مجوز ماشین‌آلات لازم است.</p>}</section>
        </aside>
      </div>
    </>:<>
      {!people.length?<div className="card calm">هنوز پرسنلی ثبت نشده است.</div>:groups.map(([role,label])=>{const list=shownPeople.filter(person=>person.role===role);if(!list.length)return null;return <section className="management-group" key={role}><h3 className="section-title">{label}<span>{fa.format(list.length)}</span></h3><div className="management-people-grid">{list.map(person=>{
        const summaryRows=canAnalyze&&(role==='driver'||role==='pm')?summary(person,role):[];const severe=[...summaryRows].filter(item=>item.count>0&&item.action).sort((a,b)=>{const toneRank=(tone:string)=>tone==='crit'?0:tone==='serious'?1:2;return toneRank(actionTone(a.action))-toneRank(actionTone(b.action))||severityOrder.indexOf(b.severity as typeof severityOrder[number])-severityOrder.indexOf(a.severity as typeof severityOrder[number])||b.count-a.count;})[0];const assigned=canSeeMachines?machinesFor(person):[];
        return <button type="button" className={`management-person-card${person.active?'':' inactive'}`} key={person.id} onClick={()=>onSelectPerson(person.id)}><span className="management-person-head">{avatar(person.name)}<span><b>{person.name}</b><small>{roleLabel[person.role]}{person.active?'':' · غیرفعال'}</small></span></span>
          {summaryRows.length?<span className="management-severity-grid">{summaryRows.map(row=><span key={row.severity} className={`management-severity sev-${row.severity}`}><small>{severityLabel[row.severity]}</small><b>{fa.format(row.count)}</b></span>)}</span>:role==='supervisor'?<span className="management-supervisor-count">سرپرست {canSeeMachines?fa.format(assigned.length):'—'} خودرو</span>:<span className="management-supervisor-count">{canAnalyze?'اطلاعات تحلیل موجود نیست':'شمارش نیازمند مجوز تحلیل'}</span>}
          {summaryRows.length>0&&<span className="management-person-foot">{canAnalyze?(severe?.action?<span className="state-pill" data-action-tone={actionTone(severe.action)}>{severe.action}</span>:<span className="st st-good"><Icon name="circle-check"/>بدون سهل‌انگاری</span>):<span className="muted small">اقدام قابل‌نمایش نیست</span>}<span className="management-machine-codes">{canSeeMachines?assigned.map(machine=><i key={machine.id}>{machine.code}</i>):'تخصیص خودرو پنهان است'}</span></span>}
        </button>;
      })}</div></section>})}
      {canAnalyze&&options&&<section className="card management-rules"><div className="card-head"><h3>قواعد اقدام مدیریتی</h3>{(permissions.settings??0)>=1&&<button type="button" className="link" onClick={()=>onNavigate('settings')}>ویرایش در تنظیمات ←</button>}</div><div className="management-rules-grid">{severityOrder.map(severity=>{
        const driverRules=options.rules?.driver?.[severity]??[];const pmRules=options.rules?.pm?.[severity]??[];
        const entries=new Map<string,{rule:Rule;roles:string[]}>();
        for(const [role,rules] of [['راننده',driverRules],['مسئول PM',pmRules]] as const)for(const rule of rules){const key=`${rule.min}:${rule.max??'*'}:${rule.action}`;const entry=entries.get(key);if(entry)entry.roles.push(role);else entries.set(key,{rule,roles:[role]});}
        return <section className={`management-rule-severity sev-${severity}`} key={severity}><h4><i/>{severityLabel[severity]}</h4><div>{[...entries.values()].map(({rule,roles})=><div className="management-rule-item" key={`${rule.min}-${rule.max}-${rule.action}`}><span>{rule.max==null?`${fa.format(rule.min)} بار و بیشتر`:rule.min===rule.max?`بار ${fa.format(rule.min)}`:`${fa.format(rule.min)} تا ${fa.format(rule.max)} بار`}</span><strong className="state-pill" data-action-tone={actionTone(rule.action)} title={roles.join(' و ')}><Icon name={actionIcon(rule.action)}/>{rule.action}</strong></div>)}</div></section>;
      })}</div><p className="muted small">شمارش دفعات: {options.countWindow==='year'?'در همان سال شمسی':options.countWindow==='12m'?'در ۱۲ ماه منتهی به امروز':'از ابتدای ثبت سوابق (مانند فایل اکسل)'}</p></section>}
    </>}
    </div>
  </section>;
}
