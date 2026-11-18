import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from './api';
import type { Section } from './shell';
import { Icon } from './shell';

const defaultStageLabels: Record<string,string> = { report:'اعلام خرابی', wait:'انتظار قطعه یا خدمات', done:'پایان تعمیر', test:'تست سلامت' };
type StageDefinition={id:string;label:string;kind:'report'|'step'|'test';limit:number|null};
type Summary = {
  active_machines:number; open_repairs:number; archived_repairs:number; service_records:number; analyses:number;
};
type Repair = {id:string;number:number;machine_code:string;title:string;stage:string;result:string|null;urgency:string;shop:string;report_date:string;expected_date:string|null;refer_date:string|null;return_date:string|null;updated_at:string;current_stage_since:string|null};
type Analysis = {id:string;machine_id:string;machine_code:string;analysis_date:string;topic:string;severity:string;responses:Record<string,string>};
type ActionRule={min:number;max:number|null;action:string};
type AnalysisOptions = {machines:{id:string;code:string;active?:boolean}[];people:{id:string;name:string;role:string}[];rules:Record<'driver'|'pm',Record<'low'|'mid'|'high',ActionRule[]>>;countWindow:'all'|'year'|'12m'};
type Maintenance = {machines:{id:string;code:string;reading:number|null}[];parts:{machine_id:string;name:string;state:string;interval_reading:number;remaining_reading:number|null;remaining_days:number|null}[]};
const fa = new Intl.NumberFormat('fa-IR');
const fullDate = new Intl.DateTimeFormat('fa-IR',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'Asia/Tehran'});
const isoToday = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const percent = (value:number,total:number) => `${fa.format(total?Math.round(value*100/total):0)}٪`;

export function Dashboard({permissions,navigate,onQuickCreate,onOpenActionPerson,companyName,orgName}:{permissions:Record<string,number>;navigate:(section:Section)=>void;onQuickCreate:(section:'repairs'|'analyses')=>void;onOpenActionPerson:(personId:string|null)=>void;companyName:string;orgName:string}) {
  const [summary,setSummary]=useState<Summary|null>(null);
  const [repairs,setRepairs]=useState<Repair[]>([]);
  const [repairStages,setRepairStages]=useState<StageDefinition[]>([]);
  const [analyses,setAnalyses]=useState<Analysis[]>([]);
  const [analysisOptions,setAnalysisOptions]=useState<AnalysisOptions>({machines:[],people:[],rules:{driver:{low:[],mid:[],high:[]},pm:{low:[],mid:[],high:[]}},countWindow:'all'});
  const [analysisMachine,setAnalysisMachine]=useState('');
  const [analysisDriver,setAnalysisDriver]=useState('');
  const [analysisPeriod,setAnalysisPeriod]=useState<'all'|'30'|'90'|'year'>('all');
  const [maintenance,setMaintenance]=useState<Maintenance|null>(null);
  const [pending,setPending]=useState(true);
  const [error,setError]=useState('');
  async function refresh(){
    setPending(true);setError('');
    try{
      const core=await api<Summary>('/dashboard');setSummary(core);
      const requests:Promise<unknown>[]=[];
      if((permissions.repairs??0)>=1){requests.push(api<Repair[]>('/repairs').then(setRepairs));requests.push(api<StageDefinition[]>('/repairs/stages').then(setRepairStages));}
      if((permissions.analyses??0)>=1){requests.push(api<Analysis[]>('/analyses').then(setAnalyses));requests.push(api<AnalysisOptions>('/analyses/options').then(setAnalysisOptions));}
      if((permissions.maint??0)>=1)requests.push(api<Maintenance>('/maintenance').then(setMaintenance));
      const results=await Promise.allSettled(requests);
      if(results.some(result=>result.status==='rejected'))setError('بخشی از جزئیات داشبورد بارگیری نشد؛ دسترسی همان بخش را بررسی کنید.');
    }catch(failure){setError(errorMessage(failure));}
    finally{setPending(false);}
  }
  useEffect(()=>{void refresh();},[permissions.repairs,permissions.analyses,permissions.maint]);

  const filteredAnalyses=useMemo(()=>analyses.filter(row=>{
    if(analysisMachine&&row.machine_id!==analysisMachine)return false;
    if(analysisDriver&&row.responses?.driver_id!==analysisDriver)return false;
    if(analysisPeriod!=='all'){
      const date=new Date(`${row.analysis_date}T00:00:00Z`),today=new Date(`${isoToday}T00:00:00Z`);
      if(analysisPeriod==='year'&&row.analysis_date.slice(0,4)!==isoToday.slice(0,4))return false;
      if(analysisPeriod==='30'&&(today.getTime()-date.getTime()>29*86400000||date>today))return false;
      if(analysisPeriod==='90'&&(today.getTime()-date.getTime()>89*86400000||date>today))return false;
    }
    return true;
  }),[analyses,analysisMachine,analysisDriver,analysisPeriod]);
  const outcome=useMemo(()=>{
    const result={driver:0,pm:0,both:0,none:0};
    for(const row of filteredAnalyses){const r=row.responses??{};const driver=r.q1==='yes'&&r.q1b==='no';const pm=r.q2==='yes'&&r.q2b==='no';
      result[driver&&pm?'both':driver?'driver':pm?'pm':'none']++;}
    return result;
  },[filteredAnalyses]);
  const open=repairs.filter(row=>!row.result);
  const reported=open.filter(row=>row.stage==='report').length;
  const inProgress=open.length-reported;
  const dayNumber=(value:string)=>{const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);return match?Math.floor(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]))/86400000):NaN;};
  const sendDays:Record<string,number|null>={urgent:0,d13:3,d47:7,none:null};
  const isLate=(row:Repair)=>{
    if(row.expected_date&&row.expected_date<isoToday)return true;
    const stage=repairStages.find(item=>item.id===row.stage);
    if(stage?.limit&&row.current_stage_since&&(Date.now()-Date.parse(row.current_stage_since))/86400000>stage.limit)return true;
    const sendLimit=sendDays[row.urgency];
    return row.stage==='report'&&!row.refer_date&&sendLimit!==null&&sendLimit!==undefined&&dayNumber(isoToday)-(dayNumber(row.report_date)+sendLimit)>0;
  };
  const late=open.filter(isLate).length;
  const stageName=(id:string)=>repairStages.find(stage=>stage.id===id)?.label??defaultStageLabels[id]??id;
  const archivedRecently=repairs.filter(row=>row.result&&(row.return_date??row.updated_at.slice(0,10))>=new Date(Date.now()-30*86400000).toISOString().slice(0,10)).length;
  const totalAnalyses=filteredAnalyses.length;
  const negligent=outcome.driver+outcome.pm+outcome.both;
  const risk=totalAnalyses===0?{label:'آماده بررسی',tone:'plain',icon:'circle-dashed'}:negligent/totalAnalyses<=.1?{label:'خوب',tone:'good',icon:'circle-check'}:negligent/totalAnalyses<=.25?{label:'نیازمند توجه',tone:'warn',icon:'triangle-alert'}:{label:'پرریسک',tone:'crit',icon:'octagon-alert'};
  const recommendations=totalAnalyses===0?['پس از ثبت تحلیل‌ها، تحلیل ریسک و پیشنهادها به‌صورت خودکار نمایش داده می‌شود.']:
    outcome.driver+outcome.both>outcome.pm+outcome.both?['تمرکز روی آموزش رانندگان و ثبت بازخورد پس از هر بررسی.','موارد تکرارشونده را برای هر راننده پیگیری کنید.','نرخ سهل‌انگاری را ماهانه بازبینی کنید.']:
      ['برنامهٔ PM و کنترل‌های پیشگیرانه را بازبینی کنید.','موارد حساس را در جلسهٔ فنی مرور کنید.','روند بررسی‌ها را به‌صورت مستمر پایش کنید.'];
  const maintenanceAlerts=(maintenance?.parts??[]).filter(part=>part.state==='over'||part.state==='soon').sort((a,b)=>a.state===b.state?0:a.state==='over'?-1:1).slice(0,7);
  const machinesMissingReading=new Set((maintenance?.machines??[]).filter(machine=>machine.reading==null).map(machine=>machine.id));
  const recent=[...filteredAnalyses].sort((a,b)=>b.analysis_date.localeCompare(a.analysis_date)).slice(0,8);
  const resultSeries=[['none','بدون سهل‌انگاری',outcome.none,'var(--good)'],['pm','سهل‌انگاری PM',outcome.pm,'var(--warn)'],['driver','سهل‌انگاری راننده',outcome.driver,'var(--crit)'],['both','مشترک',outcome.both,'#8870c8']] as const;
  let degree=0;const donut=resultSeries.map(([,label,value,color])=>{const start=degree;degree+=totalAnalyses?value*360/totalAnalyses:0;return `${color} ${start}deg ${degree}deg`;}).join(', ');
  const allMachineGroups=analysisOptions.machines.map(machine=>{
    const rows=filteredAnalyses.filter(row=>row.machine_id===machine.id);
    const counts={none:0,pm:0,driver:0,both:0};
    for(const row of rows){const r=row.responses??{};const driver=r.q1==='yes'&&r.q1b==='no';const pm=r.q2==='yes'&&r.q2b==='no';counts[driver&&pm?'both':driver?'driver':pm?'pm':'none']++;}
    return {code:machine.code,rows,counts};
  });
  const matchingMachineGroups=allMachineGroups.filter(group=>group.rows.length>0);
  const machineGroups=matchingMachineGroups.length?matchingMachineGroups:allMachineGroups.filter(group=>analysisOptions.machines.find(machine=>machine.code===group.code)?.active!==false).slice(0,6);
  const maxMachine=Math.max(1,...machineGroups.flatMap(group=>Object.values(group.counts)));
  const chartNiceMax=(value:number)=>{
    if(value<=4)return 4;
    if(value<=40)return Math.ceil(value/4)*4;
    const power=10**Math.floor(Math.log10(value)), normalized=value/power;
    return (normalized<=1?1:normalized<=2?2:normalized<=2.5?2.5:normalized<=5?5:10)*power;
  };
  const machineChartMax=chartNiceMax(maxMachine);
  const machineChart=<svg className="dashboard-data-chart" viewBox="0 0 560 240" preserveAspectRatio="none" role="img" aria-label="مقایسه نتایج بررسی‌ها بر اساس ماشین">
    {[0,1,2,3,4].map(tick=>{const value=machineChartMax*tick/4,y=12+184-tick*46;return <g key={tick}><line x1="30" x2="554" y1={y} y2={y} className={tick===0?'chart-axis':'chart-gridline'}/><text x="22" y={y+4} textAnchor="end" className="chart-tick">{fa.format(Math.round(value*10)/10)}</text></g>})}
    {machineGroups.map((group,index)=>{const groupWidth=524/machineGroups.length,groupX=554-groupWidth*(index+1),barWidth=Math.max(3,Math.min(16,(groupWidth-12)/resultSeries.length-2)),inner=resultSeries.length*barWidth+(resultSeries.length-1)*2;
      const [manufacturer,...model]=group.code.split(/\s+/);const modelLabel=model.join(' ').replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
      return <g key={group.code}>{resultSeries.map(([key,label,,color],seriesIndex)=>{const value=group.counts[key],height=value>0?Math.max(3,value/machineChartMax*184):0,x=groupX+(groupWidth-inner)/2+(resultSeries.length-1-seriesIndex)*(barWidth+2),y=12+184-height,r=Math.min(4,barWidth/2,height);
        return height>0?<path key={key} fill={color} d={'M'+x+','+(y+height)+' L'+x+','+(y+r)+' Q'+x+','+y+' '+(x+r)+','+y+' L'+(x+barWidth-r)+','+y+' Q'+(x+barWidth)+','+y+' '+(x+barWidth)+','+(y+r)+' L'+(x+barWidth)+','+(y+height)+' Z'}><title>{group.code+' · '+label+': '+fa.format(value)}</title></path>:null;})}<text x={groupX+groupWidth/2} y="214" textAnchor="middle" className="chart-xlabel"><tspan x={groupX+groupWidth/2}>{manufacturer}</tspan>{model.length>0&&<tspan x={groupX+groupWidth/2} dy="14">{modelLabel}</tspan>}</text></g>;
    })}
  </svg>;
  const monthFormatter=new Intl.DateTimeFormat('fa-IR',{month:'short',calendar:'persian',timeZone:'UTC'});
  const monthNow=new Date(`${isoToday.slice(0,7)}-01T00:00:00Z`);
  const trendRows=analyses.filter(row=>(!analysisMachine||row.machine_id===analysisMachine)&&(!analysisDriver||row.responses?.driver_id===analysisDriver));
  const trend=Array.from({length:12},(_,index)=>{
    const month=new Date(Date.UTC(monthNow.getUTCFullYear(),monthNow.getUTCMonth()-(11-index),1));
    const key=month.toISOString().slice(0,7);const rows=trendRows.filter(row=>row.analysis_date.slice(0,7)===key);
    return {label:monthFormatter.format(month),total:rows.length,negative:rows.filter(row=>{const r=row.responses??{};return (r.q1==='yes'&&r.q1b==='no')||(r.q2==='yes'&&r.q2b==='no');}).length};
  });
  const maxTrend=Math.max(1,...trend.map(point=>point.total));
  const trendChartMax=chartNiceMax(maxTrend);
  const trendChart=<svg className="dashboard-data-chart" viewBox="0 0 560 240" preserveAspectRatio="none" role="img" aria-label="روند بررسی‌ها در دوازده ماه اخیر">
    {[0,1,2,3,4].map(tick=>{const value=trendChartMax*tick/4,y=14+196-tick*49;return <g key={tick}><line x1="30" x2="546" y1={y} y2={y} className={tick===0?'chart-axis':'chart-gridline'}/><text x="22" y={y+4} textAnchor="end" className="chart-tick">{fa.format(Math.round(value*10)/10)}</text></g>})}
    {(['total','negative'] as const).map((series,index)=>{const color=index===0?'var(--c-pm)':'var(--c-driver)',points=trend.map((point,pointIndex)=>({x:546-pointIndex*(516/11),y:14+196-(point[series]/trendChartMax)*196})),path=points.map((point,pointIndex)=>(pointIndex?'L':'M')+point.x.toFixed(1)+','+point.y.toFixed(1)).join(' ');
      const area=series==='total'?path+' L'+points[points.length-1].x+',210 L'+points[0].x+',210 Z':undefined;
      return <g key={series}>{area&&<path d={area} fill={color} opacity=".12"/>}<path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>{points.map((point,pointIndex)=><circle key={pointIndex} cx={point.x} cy={point.y} r="4" fill={color} stroke="var(--surface)" strokeWidth="2"><title>{trend[pointIndex].label+' · '+(series==='total'?'کل بررسی‌ها':'موارد سهل‌انگاری')+': '+fa.format(trend[pointIndex][series])}</title></circle>)}</g>;
    })}
    {trend.map((point,index)=>{const x=546-index*(516/11);return <text key={point.label+'-'+index} x={x} y="228" textAnchor="middle" className="chart-xlabel">{point.label}</text>;})}
  </svg>;
  const activeActions=useMemo(()=>{
    const persianYear=new Intl.DateTimeFormat('en-US-u-ca-persian',{year:'numeric',timeZone:'Asia/Tehran'});
    const today=new Date(`${isoToday}T00:00:00Z`);
    const rows:{person:{id:string;name:string;role:string};role:'driver'|'pm';count:number;action:string;tone:number;severity:string}[]=[];
    for(const person of analysisOptions.people){
      if(person.role!=='driver'&&person.role!=='pm')continue;
      const role=person.role;
      for(const severity of ['low','mid','high'] as const){
        const count=analyses.filter(item=>{
          const response=item.responses??{};
          const id=response[role==='driver'?'driver_id':'pm_id'];
          const negligent=role==='driver'?response.q1==='yes'&&response.q1b==='no':response.q2==='yes'&&response.q2b==='no';
          if(id!==person.id||!negligent||(item.severity==='medium'?'mid':item.severity)!==severity)return false;
          if(analysisOptions.countWindow==='year'&&persianYear.format(new Date(item.analysis_date+'T00:00:00Z'))!==persianYear.format(today))return false;
          if(analysisOptions.countWindow==='12m'){
            const date=new Date(`${item.analysis_date}T00:00:00Z`);
            const elapsed=(today.getTime()-date.getTime())/86400000;
            if(elapsed<0||elapsed>365)return false;
          }
          return true;
        }).length;
        if(!count)continue;
        const rule=analysisOptions.rules?.[role]?.[severity]?.find(item=>count>=item.min&&(item.max==null||count<=item.max));
        if(!rule?.action)continue;
        rows.push({person,role,count,action:rule.action,tone:rule.action.includes('حقوق')?0:rule.action.includes('پاداش')?1:2,severity});
      }
    }
    return rows.sort((a,b)=>a.tone-b.tone||b.count-a.count).slice(0,7);
  },[analyses,analysisOptions]);

  return <section className="dashboard-page">
    <div className="dashboard-heading"><div><h2>داشبورد بررسی علائم و عملکرد خودرو</h2><p>{companyName} · {orgName} · امروز {fullDate.format(new Date())}</p></div></div>
    {pending&&<p role="status">در حال دریافت آمار…</p>}{error&&<p role="alert">{error}</p>}
    {summary&&<>
      {(permissions.repairs??0)>=1&&<section className="card rep-board">
        <div className="card-head"><h3><Icon name="wrench"/>خرابی‌ها و تعمیرات</h3><div className="head-acts"><button className="link" onClick={()=>navigate('repairs')}>خرابی‌های در جریان ←</button><button className="btn btn-sm btn-primary" onClick={()=>onQuickCreate('repairs')}>اعلام خرابی</button></div></div>
        <div className="rep-tiles">
          <button className="sum-tile warn" onClick={()=>navigate('repairs')}><b>{fa.format(reported)}</b><span><Icon name="factory"/>اعلام‌شده، در کارخانه</span></button>
          <button className="sum-tile info" onClick={()=>navigate('repairs')}><b>{fa.format(inProgress)}</b><span><Icon name="wrench"/>در دست تعمیر</span></button>
          <button className="sum-tile crit" onClick={()=>navigate('repairs')}><b>{fa.format(late)}</b><span><Icon name="clock"/>دارای تأخیر</span></button>
          <button className="sum-tile good" onClick={()=>navigate('archive')}><b>{fa.format(archivedRecently)}</b><span><Icon name="archive"/>بایگانی‌شده در ۳۰ روز اخیر</span></button>
        </div>
        {open.length?<ul className="alert-list">{open.slice(0,6).map(row=><li key={row.id}><button className="dashboard-row" onClick={()=>navigate('repairs')}>
          <span className="state-pill" data-due-state={isLate(row)?'over':'ok'}>{stageName(row.stage)}</span>
          <span className="al-main"><b>{row.title}</b><small>{row.machine_code} · {row.shop||'تعمیرگاه ثبت نشده'}</small></span>
          <span className="al-val">پروندهٔ {fa.format(row.number)}</span>
        </button></li>)}</ul>:<div className="calm"><Icon name="shield-check"/><span>{repairs.length?'همه ماشین‌ها سالم‌اند؛ خرابی باز یا ماشینی در تعمیرگاه وجود ندارد.':'هنوز خرابی‌ای اعلام نشده است. هر خرابی را با دکمه «اعلام خرابی» ثبت کنید تا ارسال و بازگشت از تعمیر پیگیری شود.'}</span></div>}
      </section>}

      {(permissions.analyses??0)>=1&&<>
        <h2 className="section-title dash-sec"><Icon name="clipboard-list"/>تحلیل خرابی و سهل‌انگاری</h2>
        <div className="dashboard-filters card">
          <div className="filters-title"><span>فیلترها</span></div>
          <label>راننده<select aria-label="فیلتر رانندهٔ داشبورد" value={analysisDriver} onChange={event=>setAnalysisDriver(event.target.value)}><option value="">همهٔ رانندگان</option>{analysisOptions.people.filter(person=>person.role==='driver').map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          <label>ماشین<select aria-label="فیلتر ماشین داشبورد" value={analysisMachine} onChange={event=>setAnalysisMachine(event.target.value)}><option value="">همهٔ ماشین‌ها</option>{analysisOptions.machines.map(machine=><option key={machine.id} value={machine.id}>{machine.code}</option>)}</select></label>
          <div className="dashboard-period-field"><span className="field-label">بازهٔ زمانی</span><div className="seg" role="tablist" aria-label="بازهٔ تحلیل داشبورد">{([['all','همهٔ دوره‌ها'],['30','۳۰ روز گذشته'],['90','۹۰ روز گذشته'],['year','سال جاری']] as const).map(([value,label])=><button type="button" role="tab" aria-selected={analysisPeriod===value} className={analysisPeriod===value?'on':''} key={value} onClick={()=>setAnalysisPeriod(value)}>{label}</button>)}</div></div>
          {(analysisMachine||analysisDriver||analysisPeriod!=='all')&&<button onClick={()=>{setAnalysisMachine('');setAnalysisDriver('');setAnalysisPeriod('all');}}>حذف فیلترها</button>}
        </div>
        <div className="kpis">
          {([['تعداد کل بررسی‌ها',totalAnalyses,'total','clipboard-list'],['سهل‌انگاری راننده',outcome.driver,'driver','user'],['سهل‌انگاری PM',outcome.pm,'pm','user-cog'],['سهل‌انگاری مشترک',outcome.both,'both','users'],['بدون سهل‌انگاری',outcome.none,'none','circle-check']] as const).map(([label,value,key,icon])=><button className={`kpi kpi-${key}`} key={key} onClick={()=>navigate('analyses')}><span className="kpi-top"><span className="kpi-ic"><Icon name={icon}/></span><span className="kpi-label">{label}</span><Icon name="chevron-left" className="kpi-go"/></span><div className="kpi-value">{fa.format(value)}</div><div className="kpi-sub">{key==='total'?(totalAnalyses?'بررسی‌های ثبت‌شده در فیلتر فعلی':'هنوز بررسی‌ای ثبت نشده'):`${percent(value,totalAnalyses)} از کل بررسی‌ها`}</div></button>)}
        </div>
        <div className="grid-3 dashboard-charts">
          <section className="card"><div className="card-head"><h3>توزیع نتایج بررسی‌ها</h3></div><div className="dashboard-donut" style={{background:totalAnalyses?`conic-gradient(${donut})`:undefined}}><div><b>{fa.format(totalAnalyses)}</b><small>کل بررسی‌ها</small></div></div><ul className="dashboard-legend">{resultSeries.map(([key,label,value,color])=><li key={key}><i style={{background:color}}/><span>{label}</span><b>{percent(value,totalAnalyses)}</b></li>)}</ul></section>
          <section className="card"><div className="card-head"><h3>مقایسه نتایج بر اساس ماشین</h3></div><ul className="dashboard-legend dashboard-machine-legend">{resultSeries.map(([key,label,,color])=><li key={key}><i style={{background:color}}/><span>{label}</span></li>)}</ul><div className="dashboard-empty-bars">{machineChart}</div></section>
          <section className="card"><div className="card-head"><h3>روند بررسی‌ها در ۱۲ ماه اخیر</h3></div><div className="dashboard-chart-key"><span>کل بررسی‌ها</span><span>موارد سهل‌انگاری</span></div><div className="dashboard-empty-trend">{trendChart}</div></section>
        </div>
        <div className="grid-2 dashboard-analysis-grid">
          <section className="card"><div className="card-head"><h3><Icon name="clipboard-list"/>جزئیات آخرین بررسی‌ها</h3><button className="link" onClick={()=>navigate('analyses')}>همهٔ تحلیل‌ها ←</button></div>
            {recent.length?<div className="table-wrap"><table><thead><tr><th>نتیجهٔ بررسی</th><th>سطح حساسیت</th><th>ماشین</th><th>نام راننده</th><th>تاریخ</th></tr></thead><tbody>{recent.map(row=>{const r=row.responses??{};const d=r.q1==='yes'&&r.q1b==='no',p=r.q2==='yes'&&r.q2b==='no';const result=d&&p?'مشترک':d?'راننده':p?'PM':'بدون سهل‌انگاری';const severity=row.severity==='medium'?'نیمه حساس':row.severity==='high'?'خیلی حساس':'کم اهمیت';const driver=typeof r.driver_name==='string'&&r.driver_name.trim()?r.driver_name.trim():analysisOptions.people.find(person=>person.id===r.driver_id)?.name??'—';return <tr key={row.id}><td>{result}</td><td>{severity}</td><td>{row.machine_code}</td><td>{driver}</td><td>{row.analysis_date}</td></tr>;})}</tbody></table></div>:<div className="empty dashboard-empty"><div className="empty-ic"><Icon name="clipboard-list"/></div><h4>هنوز تحلیلی ثبت نشده</h4><p>اولین تحلیل خرابی را ثبت کنید تا آمار و نمودارها پر شوند.</p>{(permissions.analyses??0)>=2&&<button className="btn btn-primary" onClick={()=>onQuickCreate('analyses')}>ثبت اولین تحلیل</button>}</div>}
          </section>
          <section className="card"><div className="card-head"><h3>وضعیت کلی ناوگان</h3></div><div className="fleet-body"><div className={`fleet-badge fleet-${risk.tone}`}><Icon name={risk.icon}/><b>{risk.label}</b></div>
            <div className="fleet-meta"><div><span>نرخ سهل‌انگاری</span><b>{percent(negligent,totalAnalyses)}</b></div><div><span>بدون سهل‌انگاری</span><b>{percent(outcome.none,totalAnalyses)}</b></div></div>
            <div className="fleet-scale" role="img" aria-label={`نرخ سهل‌انگاری ${percent(negligent,totalAnalyses)}`}><i className="s-good"/><i className="s-warn"/><i className="s-crit"/><em style={{insetInlineStart:`${Math.min(100,negligent/Math.max(1,totalAnalyses)*200)}%`}}/></div><div className="fleet-legend"><span>خوب ≤ ۱۰٪</span><span>نیازمند توجه ≤ ۲۵٪</span><span>پرریسک</span></div></div>
            <div className="dashboard-suggestion"><b><Icon name="sparkles"/>پیشنهادها</b><ul>{recommendations.map((item,index)=><li key={index}>{item}</li>)}</ul></div>
          </section>
        </div>
      </>}

      <div className="grid-2 dashboard-bottom-grid">
        {(permissions.maint??0)>=1&&<section className="card"><div className="card-head"><h3>هشدارهای نگهداری پیشگیرانه</h3><button className="link" onClick={()=>navigate('maintenance')}>رفتن به نگهداری ←</button></div>
          {machinesMissingReading.size>0&&<div className="notice notice-info"><Icon name="gauge"/><span>کارکرد فعلی {fa.format(machinesMissingReading.size)} ماشین هنوز ثبت نشده؛ برای محاسبه موعد تعویض، کیلومتر یا ساعت کار فعلی را در صفحه نگهداری وارد کنید.</span></div>}
          {maintenanceAlerts.length>0?<ul className="alert-list">{maintenanceAlerts.map((part,index)=><li key={`${part.machine_id}-${part.name}-${index}`}><button className="dashboard-row" onClick={()=>navigate('maintenance')}><span className="state-pill" data-due-state={part.state}>{part.state==='over'?'موعد گذشته':'نزدیک موعد'}</span><span className="al-main"><b>{part.name}</b><small>{maintenance?.machines.find(machine=>machine.id===part.machine_id)?.code}</small></span><span className="al-val">{part.remaining_days!=null?`${fa.format(part.remaining_days)} روز`:`${fa.format(part.remaining_reading??0)} کارکرد`}</span></button></li>)}</ul>:<div className="calm"><Icon name="shield-check"/><span>{machinesMissingReading.size?'پس از ثبت کارکرد و آخرین تعویض‌ها، هشدارها اینجا نمایش داده می‌شوند.':'هیچ قطعه‌ای نزدیک یا گذشته از موعد نیست.'}</span></div>}
        </section>}
        {(permissions.analyses??0)>=1&&(permissions.people??0)>=1&&<section className="card dashboard-actions-card"><div className="card-head"><h3>اقدامات مدیریتی جاری</h3><button className="link" onClick={()=>onOpenActionPerson(null)}>همهٔ پرسنل ←</button></div>
          {activeActions.length?<ul className="dashboard-actions-list">{activeActions.map(row=><li key={`${row.person.id}-${row.role}-${row.severity}`}><button className="dashboard-row" onClick={()=>onOpenActionPerson(row.person.id)}><span className="al-main"><b>{row.person.name}</b><small>{row.role==='driver'?'راننده':'مسئول PM'} · {row.severity==='low'?'کم اهمیت':row.severity==='mid'?'نیمه حساس':'خیلی حساس'} · {fa.format(row.count)} بار</small></span><span className="state-pill" data-action-tone={row.tone===0?'crit':row.tone===1?'serious':'warn'}>{row.action}</span></button></li>)}</ul>:<div className="calm"><Icon name="shield-check"/><span>در حال حاضر اقدام مدیریتی فعالی وجود ندارد.</span></div>}
        </section>}
      </div>
    </>}
  </section>;
}
