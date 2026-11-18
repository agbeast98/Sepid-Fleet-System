import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';

type Counts={models:number;people:number;machines:number;repairs:number;events:number;analyses:number;parts:number;alternatives:number;partLogs:number;odometerLogs:number};
type Preview={hasSource:boolean;canImport:boolean;revision:number;counts:Counts|null;target:Record<string,number>|null;directory?:{models:number;people:number;machines:number};issues:string[];fingerprint?:string};
const labels:Record<keyof Counts,string>={models:'مدل',people:'پرسنل',machines:'ماشین',repairs:'پروندهٔ خرابی',events:'رویداد مرحله',analyses:'تحلیل',parts:'قطعه',alternatives:'جایگزین قطعه',partLogs:'سابقهٔ سرویس یا تعویض',odometerLogs:'سابقهٔ کارکرد'};
const fa=new Intl.NumberFormat('fa-IR');

export function LegacyMigration(){
  const [preview,setPreview]=useState<Preview|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');
  async function refresh(){setBusy(true);setError('');setStatus('');try{setPreview(await api<Preview>('/legacy-workspace/migration-preview'));}catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}}
  async function migrate(){
    if(!preview?.canImport)return;
    setBusy(true);setError('');setStatus('');
    try{
      const result=await api<{alreadyImported:boolean;counts:Counts}>('/legacy-workspace/import-operations','POST',{revision:preview.revision});
      setStatus(result.alreadyImported?'این نسخه قبلاً منتقل شده است.':'انتقال کامل شد؛ داده‌های اصلی اکنون در جداول عملیاتی هستند.');
      await refresh();
    }catch(failure){setError(errorMessage(failure));}
    finally{setBusy(false);}
  }
  useEffect(()=>{void refresh();},[]);
  return <section className="page">
    <header className="page-head"><div className="ph-text"><h1>انتقال دادهٔ نسخهٔ قبلی</h1><p>پشتیبان نسخهٔ قبلی را بررسی کنید و داده‌های عملیاتی را با انتقال تراکنشی به پایگاه دادهٔ مشترک وارد کنید.</p></div><div className="ph-actions"><button className="btn btn-ghost" disabled={busy} onClick={()=>void refresh()}>بررسی دوباره</button></div></header>
    <section className="panel">
    <p>پشتیبان نسخهٔ قبلی روی سرور باقی می‌ماند. این مرحله داده‌های ماشین، پرسنل، تعمیرات، رویدادها، تحلیل، قطعات و سوابق را به جداول عملیاتی PostgreSQL وارد می‌کند. حساب‌های قدیمی، گزارش پیامک و کلیدهای سرویس منتقل نمی‌شوند.</p>
    {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
    {busy&&!preview&&<p role="status">در حال بررسی پشتیبان و پایگاه داده…</p>}
    {preview?.hasSource&&preview.counts&&<>
      <h3>موارد موجود در پشتیبان</h3>
      <dl className="migration-counts">{Object.entries(labels).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{fa.format(preview.counts![key as keyof Counts])}</dd></div>)}</dl>
      {preview.directory&&<p>در پایگاه مقصد اکنون {fa.format(preview.directory.machines)} ماشین، {fa.format(preview.directory.models)} مدل و {fa.format(preview.directory.people)} پرسنل پایه وجود دارد. موردهای هم‌شناسه با همان اطلاعات به‌روزرسانی می‌شوند.</p>}
      {!!preview.issues.length&&<div className="migration-issues"><h3>پیش از انتقال باید بررسی شود</h3><ul>{preview.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul></div>}
      {preview.canImport&&<div className="migration-ready"><b>پشتیبان قابل انتقال است.</b><span>انتقال تراکنشی انجام می‌شود؛ اگر هر مرحله خطا دهد، هیچ بخشی از انتقال ثبت نخواهد شد.</span><button disabled={busy} onClick={()=>void migrate()}>انتقال داده‌ها به جداول اصلی</button></div>}
    </>}
    {preview&&!preview.hasSource&&<p>هنوز فایل پشتیبان نسخهٔ قبلی روی سرور نیست. ابتدا از محیط سازگار با نسخهٔ قبلی، فایل JSON را بازیابی کنید و سپس اینجا بررسی را تکرار کنید.</p>}
    </section>
  </section>;
}
