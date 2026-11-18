import type { PoolClient } from 'pg';
import { inspectLegacyData, legacyData, legacyDate, legacyFloatingDriver, legacyStages, legacyUuid, type LegacyData, type LegacyRecord } from './legacy-migration';

const txt=(value:unknown,max=4000)=>typeof value==='string'?value.trim().slice(0,max):'';
const bool=(value:unknown)=>value!==false;
const num=(value:unknown,max=10000000)=>{const n=Number(value??0);if(!Number.isFinite(n)||n<0||n>max)throw new Error('عدد خارج از محدوده در پشتیبان قدیمی.');return Math.trunc(n);};
function isoTimestamp(value:unknown,dateValue:unknown):string{
  if(typeof value==='string'&&Number.isFinite(Date.parse(value)))return new Date(value).toISOString();
  const date=legacyDate(dateValue);if(!date)throw new Error('زمان ثبت‌شده در پشتیبان قدیمی معتبر نیست.');
  return `${date}T12:00:00+03:30`;
}
function mapStage(value:LegacyRecord,workflow:string[]):string{
  const sid=txt(value.sid,80);if(sid&&workflow.includes(sid))return sid;
  const n=Number(value.n);if(Number.isInteger(n)&&n>=1&&n<=workflow.length)return workflow[n-1];
  throw new Error('یک مرحلهٔ پرونده در تعریف مراحل پشتیبان وجود ندارد.');
}
function inferredCurrent(repair:LegacyRecord,events:{stage:string;recordedAt:string}[],workflow:string[],stageDefs:ReturnType<typeof legacyStages>):string{
  if(legacyDate(repair.returnDate))return workflow[workflow.length-1];
  const last=events.at(-1)?.stage;
  if(last===workflow[0]&&legacyDate(repair.referDate)){
    const out=stageDefs.find(stage=>stage.loc&&stage.loc!=='factory'&&stage.kind!=='test');
    return out?.id??workflow[1];
  }
  return last??(legacyDate(repair.referDate)?workflow[1]:workflow[0]);
}
function oldResult(repair:LegacyRecord):'pass'|'fail'|'old'|null{
  const test=repair.test as LegacyRecord|undefined;
  const value=txt(test?.result);
  if(value==='pass'||value==='fail')return value;
  if(value==='old'||legacyDate(repair.returnDate))return 'old';
  return null;
}
function eventRows(repair:LegacyRecord,workflow:string[],stageDefs:ReturnType<typeof legacyStages>){
  const raw=Array.isArray(repair.track)?repair.track.filter((item):item is LegacyRecord=>!!item&&typeof item==='object'&&!Array.isArray(item)):[];
  const events=raw.map(item=>({stage:mapStage(item,workflow),at:isoTimestamp(item.at,item.date||repair.reportDate),note:[txt(item.note),txt(item.byName)?`ثبت‌کنندهٔ نسخهٔ قبلی: ${txt(item.byName,150)}`:''].filter(Boolean).join(' · '),result:txt(item.result)}))
    .sort((a,b)=>a.at.localeCompare(b.at));
  if(!events.some(event=>event.stage===workflow[0]))events.unshift({stage:workflow[0],at:isoTimestamp(repair.createdAt,repair.reportDate),note:txt(repair.type),result:''});
  const report=legacyDate(repair.reportDate),refer=legacyDate(repair.referDate),returned=legacyDate(repair.returnDate);
  const out=stageDefs.find(stage=>stage.loc&&stage.loc!=='factory'&&stage.kind!=='test')?.id??workflow[1];
  if(refer&&!events.some(event=>event.stage===out))events.push({stage:out,at:isoTimestamp(null,refer),note:txt(repair.shop)?`تعمیرگاه: ${txt(repair.shop)}`:'',result:''});
  if(returned&&!events.some(event=>event.stage===workflow.at(-1)))events.push({stage:workflow.at(-1)!,at:isoTimestamp(null,returned),note:txt(repair.repairerNote),result:oldResult(repair)??'old'});
  events.sort((a,b)=>a.at.localeCompare(b.at));
  const final=oldResult(repair);
  return events.map((event,index)=>{
    const isTest=event.stage===workflow.at(-1);
    const result=isTest?(event.result==='fail'?'fail':event.result==='pass'?'pass':event.result==='old'?'old':final):null;
    if(isTest&&!result)throw new Error(`مرحلهٔ تست پروندهٔ «${txt(repair.type)}» نتیجهٔ مشخص ندارد؛ پیش‌نمایش پشتیبان را بررسی کنید.`);
    if(isTest&&result==='old'&&!event.result)event.note=[event.note,'این پرونده پیش از راه‌اندازی ثبت نتیجهٔ تست سلامت بسته شده بود.'].filter(Boolean).join(' · ');
    return {stage:event.stage,recordedAt:event.at,note:event.note,result,revision:index+1};
  });
}

export async function importLegacyOperations(client:PoolClient,payload:unknown,accountId:string){
  const data:LegacyData=legacyData(payload),inspection=inspectLegacyData(data);
  if(inspection.issues.length)throw new Error(inspection.issues.join('\n'));
  const stages=legacyStages(data),workflow=stages.map(stage=>stage.id);
  const repairs=await client.query('SELECT count(*)::int AS n FROM repairs');
  const analyses=await client.query('SELECT count(*)::int AS n FROM analyses');
  const parts=await client.query('SELECT count(*)::int AS n FROM model_parts');
  const partLogs=await client.query('SELECT count(*)::int AS n FROM part_logs');
  const odometer=await client.query('SELECT count(*)::int AS n FROM odometer_logs');
  if([repairs,analyses,parts,partLogs,odometer].some(result=>Number(result.rows[0].n)>0))throw new Error('برای ورود دادهٔ قدیمی باید جدول‌های عملیاتی پایگاه خالی باشند.');
  const counts={models:0,people:0,machines:0,repairs:0,events:0,analyses:0,parts:0,alternatives:0,partLogs:0,odometerLogs:0};

  for(const model of data.models){
    const result=await client.query(`INSERT INTO machine_models(id,name,brand) VALUES($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,brand=EXCLUDED.brand,version=machine_models.version+1`,
      [txt(model.id,100),txt(model.name,150)||'مدل',txt(model.brand,100)]);
    if(result.rowCount)counts.models++;
  }
  for(const person of data.people){
    const result=await client.query(`INSERT INTO people(id,name,role,phone,note,active) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,role=EXCLUDED.role,phone=EXCLUDED.phone,note=EXCLUDED.note,active=EXCLUDED.active,version=people.version+1`,
      [txt(person.id,100),txt(person.name,150),txt(person.role,30),txt(person.phone,40),txt(person.note),bool(person.active)]);
    if(result.rowCount)counts.people++;
  }
  for(const [index,machine] of data.machines.entries()){
    const result=await client.query(`INSERT INTO machines(id,code,plate,type,model_id,driver_id,supervisor_id,pm_id,unit,note,active,floating_driver,sort_order)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code,plate=EXCLUDED.plate,type=EXCLUDED.type,model_id=EXCLUDED.model_id,
        driver_id=EXCLUDED.driver_id,supervisor_id=EXCLUDED.supervisor_id,pm_id=EXCLUDED.pm_id,unit=EXCLUDED.unit,note=EXCLUDED.note,active=EXCLUDED.active,floating_driver=EXCLUDED.floating_driver,
        sort_order=EXCLUDED.sort_order,version=machines.version+1`,
      [txt(machine.id,100),txt(machine.code,100),txt(machine.plate,100),txt(machine.type,100),txt(machine.model,100)||null,
        legacyFloatingDriver(machine)?null:txt(machine.driverId,100)||null,txt(machine.supervisorId,100)||null,txt(machine.pmId,100)||null,machine.unit,
        txt(machine.note),bool(machine.active),legacyFloatingDriver(machine),(index+1)*10]);
    if(result.rowCount)counts.machines++;
  }
  const importedMachineIds=data.machines.map(machine=>txt(machine.id,100));
  await client.query(`WITH remaining AS (
      SELECT id,row_number() OVER (ORDER BY sort_order,id) AS position
      FROM machines WHERE NOT (id=ANY($1::text[]))
    ) UPDATE machines m SET sort_order=$2+(remaining.position*10)
      FROM remaining WHERE remaining.id=m.id`,[importedMachineIds,data.machines.length*10]);
  await client.query(`SELECT setval('machine_sort_order_seq',COALESCE((SELECT max(sort_order) FROM machines),0)+10,false)`);

  const partIdByModelAndOld=new Map<string,string>();
  for(const [modelId,list] of Object.entries(data.catalog))for(const part of list){
    const id=legacyUuid(`part:${modelId}`,part.id);partIdByModelAndOld.set(`${modelId}:${txt(part.id)}`,id);
    await client.query(`INSERT INTO model_parts(id,model_id,name,system,interval_km,interval_hours,interval_months,action,note,consequence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
      [id,modelId,txt(part.name,150)||'قطعه',txt(part.sys,100),num(part.km),num(part.hr),num(part.mo,120),txt(part.act,1)||'r',txt(part.note),txt(part.cons)]);
    counts.parts++;
    if(Array.isArray(part.alts))for(const alternative of part.alts){
      if(!alternative||typeof alternative!=='object')continue;
      const alt=alternative as LegacyRecord;if(!txt(alt.name))continue;
      await client.query(`INSERT INTO part_alternatives(id,part_id,name,source,note,approved) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
        [legacyUuid(`alternative:${modelId}:${txt(part.id)}`,alt.id),id,txt(alt.name,150),txt(alt.src,150),txt(alt.note),alt.ok===true]);counts.alternatives++;
    }
  }

  for(const log of data.odoLogs){
    const machine=data.machines.find(item=>txt(item.id)===txt(log.machineId));if(!machine)throw new Error('ماشین سابقهٔ کارکرد در پشتیبان وجود ندارد.');
    await client.query(`INSERT INTO odometer_logs(id,machine_id,recorded_on,reading,unit,recorded_by,note) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
      [legacyUuid('odometer',log.id),txt(log.machineId,100),legacyDate(log.date),num(log.value,1000000000),machine.unit,accountId,txt(log.note)]);counts.odometerLogs++;
  }
  for(const machine of data.machines){
    if(machine.odometer==null||machine.odometer==='')continue;
    const hasLog=data.odoLogs.some(log=>txt(log.machineId)===txt(machine.id)&&Number(log.value)===Number(machine.odometer));
    if(hasLog)continue;
    const date=legacyDate(machine.odoDate);if(!date)continue;
    await client.query(`INSERT INTO odometer_logs(id,machine_id,recorded_on,reading,unit,recorded_by,note) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
      [legacyUuid('odometer-current',machine.id),txt(machine.id,100),date,num(machine.odometer,1000000000),machine.unit,accountId,'کارکرد فعلی واردشده از پشتیبان قدیمی']);counts.odometerLogs++;
  }
  for(const log of data.partLogs){
    const machine=data.machines.find(item=>txt(item.id)===txt(log.machineId));if(!machine)throw new Error('ماشین سابقهٔ قطعه در پشتیبان وجود ندارد.');
    const partId=partIdByModelAndOld.get(`${txt(machine.model)}:${txt(log.partId)}`);if(!partId)throw new Error('قطعهٔ سابقه در فهرست مدل وجود ندارد.');
    const part=(data.catalog[txt(machine.model)]??[]).find(item=>txt(item.id)===txt(log.partId));
    await client.query(`INSERT INTO part_logs(id,machine_id,part_id,recorded_on,reading,unit,kind,recorded_by,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
      [legacyUuid('part-log',log.id),txt(log.machineId,100),partId,legacyDate(log.date),log.km==null||log.km===''?null:num(log.km,1000000000),machine.unit,part?.act==='r'?'replacement':'service',accountId,txt(log.note)]);counts.partLogs++;
  }

  const repairMap=new Map<string,string>();
  for(const repair of data.repairs)repairMap.set(txt(repair.id),legacyUuid('repair',repair.id));
  const repairCurrent=new Map<string,string>();
  for(const repair of data.repairs){
    const id=repairMap.get(txt(repair.id))!,events=eventRows(repair,workflow,stages);
    let current=inferredCurrent(repair,events,workflow,stages);
    if(!workflow.includes(current))current=workflow[0];
    const final=current===workflow.at(-1),outcome=final?oldResult(repair):null;
    if(final&&!outcome)throw new Error(`پروندهٔ قدیمی «${txt(repair.type)}» در مرحلهٔ تست است اما نتیجه یا تاریخ بستن آن مشخص نیست.`);
    const expected=legacyDate(repair.expectedDate),reportDate=legacyDate(repair.reportDate);
    if(!reportDate)throw new Error(`تاریخ اعلام خرابی «${txt(repair.type)}» معتبر نیست.`);
    await client.query(`INSERT INTO repairs(id,machine_id,title,urgency,shop,note,stage,result,version,created_at,updated_at,
      report_date,diagnoser,expected_date,refer_date,repairer_note,return_date,delay_reason,workflow,previous_repair_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NULL) ON CONFLICT(id) DO NOTHING`,
      [id,txt(repair.machineId,100),txt(repair.type,200)||'خرابی ثبت‌شده از نسخهٔ قدیمی',(['urgent','d13','d47','none'].includes(txt(repair.urgency))?txt(repair.urgency):'none'),
        txt(repair.shop,150),txt(repair.note),current,outcome,Math.max(1,events.length),isoTimestamp(repair.createdAt,repair.reportDate),isoTimestamp(repair.updatedAt,repair.reportDate),
        reportDate,txt(repair.diagnoser,150),expected,legacyDate(repair.referDate),txt(repair.repairerNote),legacyDate(repair.returnDate),txt(repair.delayReason),workflow]);
    repairCurrent.set(txt(repair.id),current);counts.repairs++;
    const currentResult=final?outcome:null;
    for(const event of events){
      const result=event.stage===workflow.at(-1)?(event.result??(event.stage===current?currentResult:'pass')):null;
      await client.query(`INSERT INTO repair_events(id,repair_id,revision,stage,result,note,actor_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(repair_id,revision) DO NOTHING`,
        [legacyUuid(`repair-event:${txt(repair.id)}`,String(event.revision)),id,event.revision,event.stage,result,event.note,accountId,event.recordedAt]);counts.events++;
    }
  }
  for(const repair of data.repairs){
    const previous=txt(repair.prevId);if(!previous||!repairMap.has(previous))continue;
    await client.query('UPDATE repairs SET previous_repair_id=$2 WHERE id=$1',[repairMap.get(txt(repair.id)),repairMap.get(previous)]);
  }
  for(const analysis of data.analyses){
    const severity=txt(analysis.severity)==='mid'?'medium':txt(analysis.severity);
    const responses={driver_id:txt(analysis.driverId)||null,driver_name:txt(analysis.driverName,150),pm_id:txt(analysis.pmId)||null,supervisor_id:txt(analysis.supervisorId)||null,
      q1:txt(analysis.q1),q1b:txt(analysis.q1b),q2:txt(analysis.q2),q2b:txt(analysis.q2b),q3:txt(analysis.q3),q3note:txt(analysis.q3note)};
    const repairId=repairMap.get(txt(analysis.repairId))??null;
    await client.query(`INSERT INTO analyses(id,machine_id,analysis_date,topic,cause,severity,responses,goldratt,note,created_by,created_at,repair_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
      [legacyUuid('analysis',analysis.id),txt(analysis.machineId,100),legacyDate(analysis.date),txt(analysis.topic,300)||'تحلیل واردشده از نسخهٔ قدیمی',txt(analysis.cause),severity,
        JSON.stringify(responses),JSON.stringify((analysis.goldratt&&typeof analysis.goldratt==='object'?analysis.goldratt:{})),txt(analysis.note),accountId,
        isoTimestamp(analysis.createdAt,analysis.date),repairId]);counts.analyses++;
  }
  const appStages=stages;
  const sourceSettings=data.settings;
  await client.query(`UPDATE app_settings SET payload=payload || $1::jsonb,revision=revision+1,updated_at=now() WHERE singleton`,[JSON.stringify({
    stages:appStages,
    companyName:txt(sourceSettings.companyName,180)||'شرکت دام و طیور سپید بستک',orgName:txt(sourceSettings.orgName,120)||'واحد ماشین‌آلات',
    theme:['auto','light','dark'].includes(txt(sourceSettings.theme))?sourceSettings.theme:'auto',
    warnPercent:Number.isInteger(sourceSettings.warnPercent)&&Number(sourceSettings.warnPercent)>=1&&Number(sourceSettings.warnPercent)<=100?sourceSettings.warnPercent:10,
    countWindow:['all','year','12m'].includes(txt(sourceSettings.countWindow))?sourceSettings.countWindow:'all',
    backupRemindDays:Number.isInteger(sourceSettings.backupRemindDays)&&Number(sourceSettings.backupRemindDays)>=1&&Number(sourceSettings.backupRemindDays)<=365?sourceSettings.backupRemindDays:7,
    analysisRules:data.rules??{},smsStageAlerts:false,
  })]);
  return counts;
}
