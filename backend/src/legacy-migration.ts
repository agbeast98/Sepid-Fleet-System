import { createHash } from 'node:crypto';

export type LegacyRecord = Record<string, unknown>;
export type LegacyData = LegacyRecord & {
  schema: number; settings: LegacyRecord; people: LegacyRecord[]; machines: LegacyRecord[];
  models: LegacyRecord[]; analyses: LegacyRecord[]; partLogs: LegacyRecord[];
  odoLogs: LegacyRecord[]; repairs: LegacyRecord[]; catalog: Record<string, LegacyRecord[]>;
};

const isRecord = (value: unknown): value is LegacyRecord => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export function legacyFloatingDriver(machine: LegacyRecord): boolean {
  if (typeof machine.floating === 'boolean') return machine.floating;
  return !text(machine.driverId) && text(machine.note) === 'راننده ثابت ندارد';
}

export function legacyData(payload: unknown): LegacyData {
  if (!isRecord(payload) || payload.schema !== 4 || !isRecord(payload.settings)
    || !['people','machines','models','analyses','partLogs','odoLogs','repairs'].every(key => Array.isArray(payload[key]))
    || !isRecord(payload.catalog)) throw new Error('پشتیبان باید نسخهٔ ۴ و دارای اطلاعات کامل نسخهٔ قدیمی باشد.');
  return payload as LegacyData;
}

function div(a: number, b: number): number { return Math.trunc(a / b); }
function mod(a: number, b: number): number { return a - Math.trunc(a / b) * b; }
const JALALI_BREAKS = [-61,9,38,199,426,686,756,818,1111,1181,1210,1635,2060,2097,2192,2262,2324,2394,2456,3178];
function jalaliMarch(year: number): number {
  const gy=year+621;let leapJ=-14,jp=JALALI_BREAKS[0],jm=0,jump=0;
  for(let i=1;i<JALALI_BREAKS.length;i++) { jm=JALALI_BREAKS[i];jump=jm-jp;if(year<jm)break;leapJ+=div(jump,33)*8+div(mod(jump,33),4);jp=jm; }
  const n=year-jp;leapJ+=div(n,33)*8+div(mod(n,33)+3,4);if(mod(jump,33)===4&&jump-n===4)leapJ++;
  const leapG=div(gy,4)-div((div(gy,100)+1)*3,4)-150;return 20+leapJ-leapG;
}
function isJalaliLeap(year:number):boolean{
  let jp=JALALI_BREAKS[0],jump=0,jm=0;
  for(let i=1;i<JALALI_BREAKS.length;i++){jm=JALALI_BREAKS[i];jump=jm-jp;if(year<jm)break;jp=jm;}
  let n=year-jp;if(jump-n<6)n=n-jump+div(jump+4,33)*33;
  let leap=mod(mod(n+1,33)-1,4);if(leap===-1)leap=4;return leap===0;
}
function gregorianDate(year: number, month: number, day: number): string {
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw new Error('تاریخ پشتیبان معتبر نیست.');
  return date.toISOString().slice(0,10);
}

export function legacyDate(value: unknown): string | null {
  if(value==null||value==='')return null;
  if(typeof value!=='string')throw new Error('قالب تاریخ پشتیبان معتبر نیست.');
  const normalized=value.trim().replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const parts=/^(\d{2,4})[\/\.\-](\d{1,2})[\/\.\-](\d{1,2})$/.exec(normalized);
  if(!parts)throw new Error('تاریخ پشتیبان قابل تبدیل نیست: '+value);
  let year=Number(parts[1]),month=Number(parts[2]),day=Number(parts[3]);
  if(parts[1].length===4&&year>=1900)return gregorianDate(year,month,day);
  if(year<100)year+=1400;
  if(year<1200||year>3177||month<1||month>12||day<1||day>(month<=6?31:month<=11?30:(isJalaliLeap(year)?30:29)))throw new Error('تاریخ شمسی پشتیبان معتبر نیست: '+value);
  const ordinal=(Date.UTC(year+621,2,jalaliMarch(year))+((month-1)*31-div(month,7)*(month-7)+day-1)*86400000);
  const date=new Date(ordinal);return gregorianDate(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate());
}

export function legacyUuid(kind: string, id: unknown): string {
  const source=text(id);if(!source||source.length>160)throw new Error(`شناسهٔ ${kind} در پشتیبان معتبر نیست.`);
  const bytes=createHash('sha256').update(`sepid-legacy-import:${kind}:${source}`).digest().subarray(0,16);
  bytes[6]=(bytes[6]&0x0f)|0x50;bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function legacyStages(data: LegacyData): {id:string;label:string;kind:'report'|'step'|'test';mode:'report'|'step'|'wait'|'done'|'test';loc:string|null;limit:number|null;who:string;desc:string}[] {
  const raw=data.settings.stages;
  if(!Array.isArray(raw)||raw.length<2||raw.length>12)throw new Error('تعریف مراحل پشتیبان معتبر نیست.');
  const stages=raw.map((value,index)=>{
    if(!isRecord(value))throw new Error(`مرحلهٔ ${index+1} پشتیبان معتبر نیست.`);
    const id=text(value.sid)||`legacy-stage-${index+1}`;if(id.length>80)throw new Error('شناسهٔ مرحله بیش از حد طولانی است.');
    const kind:'report'|'step'|'test'=value.kind==='report'?'report':value.kind==='test'?'test':'step';
    const mode:'report'|'step'|'wait'|'done'|'test'=value.kind==='report'?'report':value.kind==='test'?'test':(['wait','done'].includes(text(value.kind))?text(value.kind) as 'wait'|'done':'step');
    const limit=value.limit==null||value.limit===''?null:Number(value.limit);
    if(limit!==null&&(!Number.isFinite(limit)||limit<0||limit>3650))throw new Error(`مهلت مرحلهٔ ${id} معتبر نیست.`);
    return {id,label:(text(value.label)||`مرحله ${index+1}`).slice(0,120),kind,mode,loc:text(value.loc)||null,limit,who:text(value.who).slice(0,80),desc:text(value.desc).slice(0,500)};
  });
  if(stages[0].kind!=='report'||stages[stages.length-1].kind!=='test'||stages.slice(1,-1).some(stage=>stage.kind!=='step'))throw new Error('مسیر مراحل پشتیبان باید با اعلام خرابی شروع و با تست سلامت تمام شود.');
  if(new Set(stages.map(stage=>stage.id)).size!==stages.length)throw new Error('شناسهٔ مراحل پشتیبان تکراری است.');
  return stages;
}

export function inspectLegacyData(data: LegacyData) {
  const issues:string[]=[];
  const namedRows:[string,LegacyRecord[]][]=[['مدل',data.models],['پرسنل',data.people],['ماشین',data.machines],['خرابی',data.repairs],['تحلیل',data.analyses],['سابقهٔ کارکرد',data.odoLogs],['سابقهٔ سرویس',data.partLogs]];
  for(const [label,rows] of namedRows)if(rows.some(row=>!isRecord(row)))issues.push(`یکی از رکوردهای ${label} در پشتیبان معتبر نیست.`);
  if(issues.length)return {issues,counts:{models:0,people:0,machines:0,repairs:0,events:0,analyses:0,parts:0,alternatives:0,partLogs:0,odometerLogs:0}};
  const models=new Set(data.models.map(row=>text(row.id)));
  const people=new Map(data.people.map(row=>[text(row.id),text(row.role)]));
  const machines=new Set(data.machines.map(row=>text(row.id)));
  let workflow:ReturnType<typeof legacyStages>;
  try{workflow=legacyStages(data);}catch(error){
    const message=error instanceof Error?error.message:'تعریف مسیر مراحل پشتیبان معتبر نیست.';
    return {issues:[message],counts:{models:0,people:0,machines:0,repairs:0,events:0,analyses:0,parts:0,alternatives:0,partLogs:0,odometerLogs:0}};
  }
  const workflowIds=new Set(workflow.map(stage=>stage.id));
  const parts=new Map<string,Set<string>>();
  for(const [modelId,list] of Object.entries(data.catalog)){
    if(!Array.isArray(list)){issues.push(`فهرست قطعات مدل «${modelId}» معتبر نیست.`);continue;}
    if(!models.has(modelId))issues.push(`مدل «${modelId}» برای فهرست قطعات در پشتیبان وجود ندارد.`);
    if(list.some(item=>!isRecord(item))){issues.push(`یکی از قطعات مدل «${modelId}» معتبر نیست.`);parts.set(modelId,new Set());continue;}
    const partIds=list.map(item=>text(item.id));
    if(partIds.some(id=>!id)||new Set(partIds).size!==partIds.length)issues.push(`شناسهٔ قطعات مدل «${modelId}» خالی یا تکراری است.`);
    for(const part of list)if(Array.isArray(part.alts))for(const alternative of part.alts){
      if(!isRecord(alternative)||!text(alternative.id)||!text(alternative.name))issues.push(`جایگزین قطعهٔ «${text(part.name)||text(part.id)}» در مدل «${modelId}» شناسه یا نام معتبر ندارد.`);
    }
    parts.set(modelId,new Set(partIds));
  }
  const checkUnique=(rows:LegacyRecord[],kind:string)=>{
    const ids=rows.map(row=>text(row.id));
    if(ids.some(id=>!id)||new Set(ids).size!==ids.length)issues.push(`شناسهٔ ${kind} خالی یا تکراری است.`);
  };
  checkUnique(data.models,'مدل');checkUnique(data.people,'پرسنل');checkUnique(data.machines,'ماشین');
  checkUnique(data.repairs,'خرابی');checkUnique(data.analyses,'تحلیل');
  for(const person of data.people)if(!['driver','supervisor','pm'].includes(text(person.role)))issues.push(`نقش پرسنل «${text(person.name)||text(person.id)}» قابل انتقال نیست.`);
  for(const machine of data.machines){
    if(!text(machine.code))issues.push(`کد ماشین «${text(machine.id)}» خالی است.`);
    if(machine.floating!==undefined&&typeof machine.floating!=='boolean')issues.push(`وضعیت رانندهٔ متغیر برای ماشین «${text(machine.code)||text(machine.id)}» نامعتبر است.`);
    if(machine.model&&!models.has(text(machine.model)))issues.push(`مدل ماشین «${text(machine.code)}» در پشتیبان وجود ندارد.`);
    for(const [field,role] of [['driverId','driver'],['supervisorId','supervisor'],['pmId','pm']]){
      if(field==='driverId'&&legacyFloatingDriver(machine))continue;
      const id=text(machine[field]);if(id&&people.get(id)!==role)issues.push(`ارجاع ${field} ماشین «${text(machine.code)}» به پرسنل نامعتبر است.`);
    }
    if(machine.unit!=='km'&&machine.unit!=='hour')issues.push(`واحد کارکرد ماشین «${text(machine.code)}» نامعتبر است.`);
  }
  for(const repair of data.repairs){
    if(!machines.has(text(repair.machineId)))issues.push(`ماشین پروندهٔ «${text(repair.type)||text(repair.id)}» در پشتیبان نیست.`);
    try{if(!legacyDate(repair.reportDate))throw new Error();for(const key of ['expectedDate','referDate','returnDate'])if(repair[key])legacyDate(repair[key]);}
    catch{issues.push(`تاریخ‌های پروندهٔ «${text(repair.type)||text(repair.id)}» معتبر نیستند.`);}
    const tracks=Array.isArray(repair.track)?repair.track:[];
    if(tracks.some(item=>!isRecord(item)||(!text(item.sid)&&!Number.isInteger(Number(item.n)))))issues.push(`یک رویداد مرحله در پروندهٔ «${text(repair.type)||text(repair.id)}» شناسه ندارد.`);
    for(const item of tracks)if(isRecord(item)){
      const stageId=text(item.sid),stageNumber=Number(item.n);
      if((stageId&&!workflowIds.has(stageId))&&(!Number.isInteger(stageNumber)||stageNumber<1||stageNumber>workflow.length))issues.push(`مرحلهٔ ثبت‌شده در پروندهٔ «${text(repair.type)||text(repair.id)}» در مسیر مراحل وجود ندارد.`);
    }
    if(repair.prevId&&(!data.repairs.some(previous=>text(previous.id)===text(repair.prevId))||text(repair.prevId)===text(repair.id)))issues.push(`ارجاع پروندهٔ قبلی برای «${text(repair.type)||text(repair.id)}» معتبر نیست.`);
  }
  for(const analysis of data.analyses){
    if(!machines.has(text(analysis.machineId)))issues.push(`ماشین تحلیل «${text(analysis.topic)||text(analysis.id)}» در پشتیبان نیست.`);
    if(!['low','mid','medium','high','critical'].includes(text(analysis.severity)))issues.push(`شدت تحلیل «${text(analysis.topic)||text(analysis.id)}» قابل انتقال نیست.`);
    try{if(!legacyDate(analysis.date))throw new Error();}catch{issues.push(`تاریخ تحلیل «${text(analysis.topic)||text(analysis.id)}» معتبر نیست.`);}
    if(analysis.repairId&&!data.repairs.some(repair=>text(repair.id)===text(analysis.repairId)))issues.push(`پروندهٔ مرتبط با تحلیل «${text(analysis.topic)||text(analysis.id)}» در پشتیبان نیست.`);
  }
  for(const log of data.odoLogs){
    if(!machines.has(text(log.machineId)))issues.push(`ماشین یک سابقهٔ کارکرد در پشتیبان نیست.`);
    try{if(!legacyDate(log.date))throw new Error();}catch{issues.push('تاریخ یک سابقهٔ کارکرد معتبر نیست.');}
  }
  for(const log of data.partLogs){
    const machine=data.machines.find(item=>text(item.id)===text(log.machineId));
    if(!machine)issues.push('ماشین یک سابقهٔ سرویس در پشتیبان نیست.');
    if(!parts.get(text(machine?.model))?.has(text(log.partId)))issues.push('قطعهٔ یک سابقهٔ سرویس در فهرست مدل وجود ندارد.');
    try{if(!legacyDate(log.date))throw new Error();}catch{issues.push('تاریخ یک سابقهٔ سرویس یا تعویض معتبر نیست.');}
  }
  const partCount=[...parts.values()].reduce((sum,list)=>sum+list.size,0);
  const alternativeCount=Object.values(data.catalog).reduce((sum,list)=>sum+list.reduce((n,item)=>n+(isRecord(item)&&Array.isArray(item.alts)?item.alts.length:0),0),0);
  const eventCount=data.repairs.reduce((sum,row)=>sum+(Array.isArray(row.track)?row.track.length:0),0);
  return {issues:[...new Set(issues)],counts:{models:data.models.length,people:data.people.length,machines:data.machines.length,repairs:data.repairs.length,events:eventCount,analyses:data.analyses.length,parts:partCount,alternatives:alternativeCount,partLogs:data.partLogs.length,odometerLogs:data.odoLogs.length}};
}
