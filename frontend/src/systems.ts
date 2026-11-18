export const partSystems = [
  ['eng','موتور'],
  ['cool','سیستم خنک‌کاری'],
  ['fuel','سیستم سوخت‌رسانی'],
  ['air','هواکش، توربو و اگزوز'],
  ['elec','برق و الکترونیک'],
  ['clutch','کلاچ'],
  ['tc','مبدل گشتاور (تورک کانورتور)'],
  ['gear','گیربکس'],
  ['drive','گاردان و انتقال قدرت'],
  ['axle','دیفرانسیل و محورها'],
  ['susp','سیستم تعلیق'],
  ['steer','سیستم فرمان'],
  ['brake','سیستم ترمز (بادی)'],
  ['brakeh','سیستم ترمز'],
  ['hyd','سیستم هیدرولیک'],
  ['boom','بازو، باکت و اتصالات'],
  ['hitch','اتصال سه‌نقطه، PTO و مالبند'],
  ['wheel','چرخ و لاستیک'],
  ['cab','کابین، شاسی و بدنه'],
  ['hvac','بخاری و کولر'],
  ['body','اتاق بار'],
  ['lube','گریس‌کاری و روان‌کاری دوره‌ای'],
  ['other','سایر قطعات'],
] as const;

const labels = new Map<string,string>(partSystems.map(([id,name])=>[id,name]));
export function partSystemName(value:string|null|undefined):string {
  return value ? labels.get(value) ?? value : 'سایر قطعات';
}

export function comparePartSystems(a:string,b:string):number {
  const ai=partSystems.findIndex(([id])=>id===a),bi=partSystems.findIndex(([id])=>id===b);
  if(ai<0&&bi<0)return partSystemName(a).localeCompare(partSystemName(b),'fa');
  if(ai<0)return 1;
  if(bi<0)return -1;
  return ai-bi;
}
