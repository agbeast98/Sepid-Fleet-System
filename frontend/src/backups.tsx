import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';

type Backup = { name: string; size: number; createdAt: string };

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} کیلوبایت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگابایت`;
}

export function Backups() {
  const [items, setItems] = useState<Backup[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  async function refresh() {
    setLoading(true);
    setError('');
    try { setItems(await api<Backup[]>('/backups')); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  return <section className="page">
    <div className="page-head"><div><h1>پشتیبان‌های پایگاه داده</h1><p>فهرست نسخه‌های زمان‌بندی‌شدهٔ پایگاه دادهٔ سامانه.</p></div><button className="btn btn-ghost" onClick={() => void refresh()} disabled={loading}>تازه‌سازی</button></div>
    <div className="card" role="note"><b>دسترسی مدیرکل</b><p>این فایل‌ها شامل اطلاعات همهٔ کاربران و پرونده‌هاست. فایل پشتیبان را فقط در فضای امن نگه دارید. این صفحه نسخه‌ها را نمایش می‌دهد و دریافت می‌کند؛ بازیابی باید با هماهنگی فنی و پس از تهیهٔ نسخهٔ امن انجام شود.</p></div>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">در حال دریافت فهرست…</p> : items.length === 0 ? <div className="card"><p>هنوز نسخهٔ پشتیبانی در مخزن سرور پیدا نشد.</p><small>زمان‌بندی پشتیبان‌گیری در استقرار Docker فعال است؛ اولین نسخه پس از اجرای چرخهٔ پشتیبان‌گیری ساخته می‌شود.</small></div> : <div className="card table-wrap"><table><thead><tr><th>زمان ایجاد</th><th>اندازه</th><th>فایل</th><th>عملیات</th></tr></thead><tbody>{items.map(item => <tr key={item.name}><td>{new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' }).format(new Date(item.createdAt))}</td><td>{formatSize(item.size)}</td><td dir="ltr">{item.name}</td><td><a className="btn btn-ghost" href={`/api/v1/backups/${encodeURIComponent(item.name)}`}>دریافت فایل</a></td></tr>)}</tbody></table></div>}
  </section>;
}
