import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Icon } from './shell';

const monthNames = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
const weekNames = ['ش','ی','د','س','چ','پ','ج'];
const breaks = [-61,9,38,199,426,686,756,818,1111,1181,1210,1635,2060,2097,2192,2262,2324,2394,2456,3178];
const div = (a:number,b:number)=>Math.trunc(a/b);
const mod = (a:number,b:number)=>a-div(a,b)*b;
const toFa = (value:string|number)=>String(value).replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
const toEn = (value:string)=>value.replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

function jalCal(jy:number,withoutLeap=false){
  const gy=jy+621;let leapJ=-14,jp=breaks[0],jm=0,jump=0;
  for(let i=1;i<breaks.length;i++){jm=breaks[i];jump=jm-jp;if(jy<jm)break;leapJ+=div(jump,33)*8+div(mod(jump,33),4);jp=jm;}
  let n=jy-jp;leapJ+=div(n,33)*8+div(mod(n,33)+3,4);if(mod(jump,33)===4&&jump-n===4)leapJ++;
  const leapG=div(gy,4)-div((div(gy,100)+1)*3,4)-150;const march=20+leapJ-leapG;
  if(withoutLeap)return {gy,march};
  if(jump-n<6)n=n-jump+div(jump+4,33)*33;
  let leap=mod(mod(n+1,33)-1,4);if(leap===-1)leap=4;
  return {gy,march,leap};
}
function g2d(gy:number,gm:number,gd:number){let d=div((gy+div(gm-8,6)+100100)*1461,4)+div(153*mod(gm+9,12)+2,5)+gd-34840408;d=d-div(div(gy+100100+div(gm-8,6),100)*3,4)+752;return d;}
function d2g(jdn:number){let j=4*jdn+139361631;j+=div(div(4*jdn+183187720,146097)*3,4)*4-3908;const i=div(mod(j,1461),4)*5+308;const gd=div(mod(i,153),5)+1,gm=mod(div(i,153),12)+1,gy=div(j,1461)-100100+div(8-gm,6);return {gy,gm,gd};}
function j2d(jy:number,jm:number,jd:number){const r=jalCal(jy,true);return g2d(r.gy,3,r.march)+(jm-1)*31-div(jm,7)*(jm-7)+jd-1;}
function d2j(jdn:number){const gy=d2g(jdn).gy;let jy=gy-621;const r=jalCal(jy);const first=g2d(gy,3,r.march);let k=jdn-first,jm:number,jd:number;if(k>=0){if(k<=185){jm=1+div(k,31);jd=mod(k,31)+1;return {jy,jm,jd};}k-=186;}else{jy--;k+=179;if(r.leap===1)k++;}jm=7+div(k,30);jd=mod(k,30)+1;return {jy,jm,jd};}
function monthLength(year:number,month:number){return month<=6?31:month<=11?30:(jalCal(year).leap===0?30:29);}
function parseJalali(input:string){
  const value=toEn(input).trim();const match=/^(\d{2,4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/.exec(value);if(!match)return null;
  let jy=Number(match[1]);const jm=Number(match[2]),jd=Number(match[3]);if(jy<100)jy+=1400;
  if(jm<1||jm>12||jd<1||jd>monthLength(jy,jm))return null;return {jy,jm,jd};
}
function dateIso(gy:number,gm:number,gd:number){return `${gy}-${String(gm).padStart(2,'0')}-${String(gd).padStart(2,'0')}`;}
export function isoToPersianDate(value:string){const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);if(!match)return '';const parsed=d2j(g2d(Number(match[1]),Number(match[2]),Number(match[3])));return `${toFa(parsed.jy)}/${toFa(String(parsed.jm).padStart(2,'0'))}/${toFa(String(parsed.jd).padStart(2,'0'))}`;}
export function persianDateToIso(input:string){
  const value=toEn(input).trim();const gregorian=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if(gregorian){const [gy,gm,gd]=gregorian.slice(1).map(Number);const date=new Date(Date.UTC(gy,gm-1,gd));return date.getUTCFullYear()===gy&&date.getUTCMonth()+1===gm&&date.getUTCDate()===gd?dateIso(gy,gm,gd):'';}
  const parsed=parseJalali(value);if(!parsed)return '';const greg=d2g(j2d(parsed.jy,parsed.jm,parsed.jd));return dateIso(greg.gy,greg.gm,greg.gd);
}
const todayIso=()=>{const now=new Date();const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tehran',calendar:'gregory',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));return `${values.year}-${values.month}-${values.day}`;};

type Props={name?:string;value?:string;defaultValue?:string;onChange?:(value:string)=>void;min?:string;max?:string;required?:boolean;disabled?:boolean;className?:string;ariaLabel?:string};
export function PersianDateInput({name,value,defaultValue='',onChange,min,max,required,disabled,className='input',ariaLabel}:Props){
  const inputRef=useRef<HTMLInputElement>(null);const popRef=useRef<HTMLDivElement>(null);
  const [iso,setIso]=useState(value??defaultValue);const [display,setDisplay]=useState(isoToPersianDate(value??defaultValue));
  const [open,setOpen]=useState(false);const [view,setView]=useState(()=>parseJalali(isoToPersianDate(value??defaultValue))??parseJalali(isoToPersianDate(todayIso()))!);
  const [position,setPosition]=useState({left:8,top:8});
  useEffect(()=>{if(value!==undefined){setIso(value);setDisplay(isoToPersianDate(value));}},[value]);
  function positionCalendar(){const rect=inputRef.current?.getBoundingClientRect();if(!rect)return;const left=Math.max(8,Math.min(rect.right-288,window.innerWidth-296));const top=rect.bottom+6+340>window.innerHeight&&rect.top>340?rect.top-336:rect.bottom+6;setPosition({left,top});}
  function showCalendar(){if(disabled)return;const parsed=parseJalali(isoToPersianDate(iso))??parseJalali(isoToPersianDate(todayIso()))!;setView(parsed);positionCalendar();setOpen(true);}
  function validationMessage(nextIso:string){if(!nextIso)return '';if(min&&nextIso<min)return 'تاریخ باید در بازهٔ مجاز باشد.';if(max&&nextIso>max)return 'تاریخ باید در بازهٔ مجاز باشد.';return '';}
  function commit(nextIso:string,nextDisplay=isoToPersianDate(nextIso)){setIso(nextIso);setDisplay(nextDisplay);inputRef.current?.setCustomValidity(validationMessage(nextIso));onChange?.(nextIso);}
  function edit(event:ChangeEvent<HTMLInputElement>){const raw=event.target.value;setDisplay(raw);const next=persianDateToIso(raw);event.target.setCustomValidity(raw&&!next?'تاریخ شمسی معتبر وارد کنید.':validationMessage(next));commit(next,raw);}
  function choose(day:number){const isoValue=persianDateToIso(`${view.jy}/${view.jm}/${day}`);if(validationMessage(isoValue))return;commit(isoValue);setOpen(false);}
  function clear(){commit('','');setOpen(false);}
  function chooseToday(){commit(todayIso());setOpen(false);}
  useEffect(()=>{if(!open)return;positionCalendar();const outside=(event:MouseEvent)=>{if(!popRef.current?.contains(event.target as Node)&&event.target!==inputRef.current)setOpen(false);};const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);if(event.key==='Tab')setOpen(false);};document.addEventListener('mousedown',outside,true);document.addEventListener('keydown',key,true);window.addEventListener('resize',positionCalendar);window.addEventListener('scroll',positionCalendar,true);return()=>{document.removeEventListener('mousedown',outside,true);document.removeEventListener('keydown',key,true);window.removeEventListener('resize',positionCalendar);window.removeEventListener('scroll',positionCalendar,true);};},[open]);
  const firstWeekday=(j2d(view.jy,view.jm,1)+1)%7;const days=monthLength(view.jy,view.jm);const selected=parseJalali(isoToPersianDate(iso));const today=parseJalali(isoToPersianDate(todayIso()));
  const cells=Array.from({length:firstWeekday},(_,index)=><span key={`blank-${index}`}/>).concat(Array.from({length:days},(_,index)=>{const day=index+1;const selectedDay=selected?.jy===view.jy&&selected.jm===view.jm&&selected.jd===day;const todayDay=today?.jy===view.jy&&today.jm===view.jm&&today.jd===day;const dayIso=persianDateToIso(`${view.jy}/${view.jm}/${day}`);return <button key={day} type="button" className={`dp-day${selectedDay?' sel':''}${todayDay?' today':''}`} aria-pressed={selectedDay} disabled={!!validationMessage(dayIso)} onClick={()=>choose(day)}>{toFa(day)}</button>;}));
  function moveMonth(amount:number){setView(current=>{let jy=current.jy,jm=current.jm+amount;if(jm<1){jm=12;jy--;}if(jm>12){jm=1;jy++;}return {jy,jm,jd:1};});}
  return <div className="input-date"><Icon name="calendar"/><input ref={inputRef} type="text" dir="ltr" className={className} value={display} placeholder="۱۴۰۵/۰۱/۰۱" aria-label={ariaLabel} required={required} disabled={disabled} autoComplete="off" onFocus={showCalendar} onClick={()=>{if(!open)showCalendar();}} onChange={edit} onBlur={event=>{const parsed=persianDateToIso(event.target.value);event.currentTarget.setCustomValidity(event.target.value&&!parsed?'تاریخ شمسی معتبر وارد کنید.':validationMessage(parsed));}}/>{name&&<input type="hidden" name={name} value={iso}/>}
    {open&&createPortal(<div className="datepicker" ref={popRef} style={{position:'fixed',left:position.left,top:position.top}}>
      <div className="dp-head"><button type="button" className="icon-btn" aria-label="ماه قبل" onClick={()=>moveMonth(-1)}><Icon name="chevron-right"/></button><div className="dp-title"><b>{monthNames[view.jm-1]}</b> <span>{toFa(view.jy)}</span></div><button type="button" className="icon-btn" aria-label="ماه بعد" onClick={()=>moveMonth(1)}><Icon name="chevron-left"/></button></div>
      <div className="dp-week">{weekNames.map((day,index)=><span key={`${day}-${index}`}>{day}</span>)}</div><div className="dp-grid">{cells}</div><div className="dp-foot"><button type="button" className="btn btn-sm btn-ghost" onClick={chooseToday}>امروز</button><button type="button" className="btn btn-sm btn-ghost" onClick={clear}>پاک کردن</button></div>
    </div>,document.body)}
  </div>;
}
