import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { Icon } from './shell';

type Stage = { id: string; label: string; kind: 'report' | 'step' | 'test'; mode?:'report'|'step'|'wait'|'done'|'test'; loc?:string; who?:string; desc?:string; limit: number | null };
const fallbackStages: Stage[] = [
  { id: 'report', label: 'اعلام خرابی (ماشین در کارخانه)', kind: 'report', mode:'report', loc:'factory', who:'سرپرست', desc:'خرابی ثبت شده و ماشین هنوز در کارخانه است', limit: null },
  { id: 'wait', label: 'در انتظار قطعه یا خدمات', kind: 'step', mode:'wait', loc:'part', who:'تعمیرات', desc:'ماشین برای تعمیر رفته و در انتظار تأمین قطعه یا انجام خدمات تعمیر است', limit: 7 },
  { id: 'done', label: 'پایان تعمیر', kind: 'step', mode:'done', loc:'shop', who:'تعمیرات', desc:'تعمیر تمام شده و ماشین باید در کارخانه تست سلامت شود', limit: 2 },
  { id: 'test', label: 'تست سلامت (ماشین در کارخانه)', kind: 'test', mode:'test', loc:'done', who:'سرپرست', desc:'ماشین در کارخانه آزمایش می‌شود؛ اگر قبول شود پرونده بایگانی می‌شود و اگر رد شود خرابی جدید ثبت می‌شود', limit: null },
];

function RoleCard({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return <div className="g-role"><div className="g-role-h"><span><Icon name={icon} /></span><b>{title}</b></div><ol>{children}</ol></div>;
}

export function Guide() {
  const [stages, setStages] = useState<Stage[]>(fallbackStages);
  useEffect(() => { api<Stage[]>('/repairs/stages').then(setStages).catch(() => {}); }, []);
  const label = (kind: Stage['kind']) => stages.find(stage => stage.kind === kind)?.label ?? '';
  const serviceStage = stages.find(stage => stage.mode === 'wait' || stage.id === 'wait')?.label ?? stages.find(stage => stage.kind === 'step')?.label ?? 'مرحلهٔ تعمیر';
  const completionStage = [...stages].reverse().find(stage => stage.mode === 'done' || stage.id === 'done')?.label ?? [...stages].reverse().find(stage => stage.kind === 'step')?.label ?? 'مرحلهٔ پایان تعمیر';
  const digits = (value: number) => value.toLocaleString('fa-IR');
  const location = (stage: Stage) => stage.loc ?? (stage.mode === 'wait' ? 'part' : stage.mode === 'done' ? 'shop' : stage.kind === 'test' ? 'done' : 'factory');
  const deadline = (stage: Stage, index: number) => stage.limit ? `حداکثر ${digits(stage.limit)} روز` : index === 0 ? 'طبق سطح ضرورت' : '';

  return <div className="page guide">
    <section className="g-hero">
      <div className="g-hero-ic"><Icon name="book-open" /></div>
      <div><h2>رویه کار با سامانه ناوگان</h2><p>این صفحه نشان می‌دهد هر کار در سامانه از کجا شروع می‌شود، چه کسی انجامش می‌دهد و نتیجه‌اش کجا ثبت می‌شود. اگر کسی تازه با سامانه کار می‌کند، از همین صفحه شروع کند.</p></div>
    </section>

    <section className="card g-sec">
      <div className="g-sec-h"><span className="g-badge">۱</span><div><h3>چرخه خرابی: از اعلام تا بایگانی</h3><p>هر خرابی {digits(stages.length)} مرحله دارد و مراحل فقط <b>به ترتیب</b> ثبت می‌شوند؛ تا مرحله قبل ثبت نشده باشد، مرحله بعد قفل است.</p></div></div>
      <div className="g-flow">{stages.map((stage, index) => <Fragment key={stage.id}><div className={`gf-step loc-${location(stage)}`}>
        <span className="gf-n">{digits(index + 1)}</span><div className="gf-body"><b>{stage.label}</b>
          <small>{stage.desc || (stage.kind === 'report' ? 'خرابی ثبت شده و ماشین هنوز در کارخانه است' : stage.kind === 'test' ? 'نتیجه تست سلامت ثبت می‌شود و پرونده تعیین تکلیف می‌شود' : 'وضعیت تعمیر و قطعه یا خدمات موردنیاز ثبت می‌شود')}</small>
          {(stage.who || deadline(stage, index)) && <div className="gf-meta">{stage.who && <span><Icon name="user" />{stage.who}</span>}{deadline(stage, index) && <span><Icon name="clock" />{deadline(stage, index)}</span>}{index>0&&<span title="در صورت فعال بودن قانون، پیام در صف قرار می‌گیرد"><Icon name="message-square"/>پیامک</span>}</div>}
        </div>
      </div>{index < stages.length - 1 && <div className="gf-arrow"><Icon name="lock-open" /><small>بعد از ثبت</small></div>}</Fragment>)}</div>
      <div className="g-branch">
        <div className="g-br good"><Icon name="circle-check" /><div><b>تست سلامت قبول شد</b><small>پرونده بسته می‌شود و به «بایگانی تعمیرات» و تاریخچه ماشین می‌رود. ماشین دوباره «سالم و در حال کار» نمایش داده می‌شود.</small></div></div>
        <div className="g-br crit"><Icon name="circle-x" /><div><b>تست سلامت رد شد</b><small>پرونده بسته می‌شود و سامانه امکان ثبت خرابی جدیدِ پیوندخورده به پرونده قبلی را می‌دهد تا چرخه از مرحله ۱ دوباره آغاز شود.</small></div></div>
      </div>
    </section>

    <section className="card g-sec">
      <div className="g-sec-h"><span className="g-badge">۲</span><div><h3>چه کسی، چه کاری؟</h3><p>هر کاربر فقط مراحلی را ثبت می‌کند که مدیر کل در «کاربران و دسترسی‌ها» برایش روشن کرده است.</p></div></div>
      <div className="g-roles">
        <RoleCard icon="user-check" title="سرپرست ماشین‌آلات"><li>خرابی را با دکمه <b>«اعلام خرابی»</b> ثبت می‌کند: ماشین، نوع خرابی و سطح ضرورت.</li><li>وقتی ماشین برای تعمیر رفت، از <b>«ثبت مرحله بعد»</b> مرحله «{serviceStage}» را با نام تعمیرگاه ثبت می‌کند.</li><li>هر روز صفحه <b>«وضعیت ماشین‌ها»</b> را نگاه می‌کند؛ کارت‌های قرمز یعنی تأخیر.</li></RoleCard>
        <RoleCard icon="wrench" title="تعمیرات"><li>قطعه یا خدمتی را که منتظرش است در مرحلهٔ «{serviceStage}» می‌نویسد و هر تغییر را با «به‌روزرسانی همین مرحله» ثبت می‌کند.</li><li>وقتی کار تمام شد، «{completionStage}» را با شرح کار انجام‌شده ثبت می‌کند.</li><li>اگر ارسال برای مرحله فعال باشد، پیامک سرپرست در صف ارسال قرار می‌گیرد.</li></RoleCard>
        <RoleCard icon="stethoscope" title="مسئول تست سلامت"><li>ماشین را در کارخانه آزمایش می‌کند (کار زیر بار، نشتی، صدا و موارد لازم).</li><li>نتیجه را در مرحله <b>«{label('test')}»</b> با «قبول» یا «رد» و شرح تست ثبت می‌کند.</li><li>اگر رد شد، پیشنهاد «اعلام خرابی جدید» را تأیید می‌کند.</li></RoleCard>
        <RoleCard icon="shield-check" title="مدیر کل"><li>کاربر می‌سازد و تعیین می‌کند هر نفر کدام بخش و کدام مرحله را ببیند یا ثبت کند.</li><li>تعریف‌ها را در <b>«تنظیمات و تعاریف»</b> نگه می‌دارد.</li><li>هفته‌ای یک بار از بخش <b>«پشتیبان‌گیری»</b> فایل پایگاه‌دادهٔ سرور را دریافت می‌کند.</li></RoleCard>
      </div>
    </section>

    <section className="card g-sec">
      <div className="g-sec-h"><span className="g-badge">۳</span><div><h3>نگهداری پیشگیرانه</h3><p>فهرست قطعات هر مدل را خودتان وارد می‌کنید؛ سامانه موعد هر قطعه را حساب می‌کند.</p></div></div>
      <div className="g-steps">
        <div><span>۱</span><b>تعریف قطعه</b><small>نگهداری پیشگیرانه ← ماشین ← «افزودن قطعه»: نام، سیستم، نوع اقدام (تعویض، بازدید، سرویس، تنظیم، مصرفی) و دوره کیلومتری / ساعتی / ماهانه.</small></div>
        <div><span>۲</span><b>ثبت کارکرد</b><small>کیلومتر یا ساعت کار فعلی ماشین را ثبت کنید. لودر و تراکتور با «ساعت کار» حساب می‌شوند.</small></div>
        <div><span>۳</span><b>ثبت تعویض</b><small>هر بار قطعه‌ای عوض یا سرویس شد، دکمه «ثبت» کنار همان قطعه را بزنید.</small></div>
        <div><span>۴</span><b>دنبال کردن رنگ‌ها</b><small>زرد یعنی نزدیک موعد، قرمز یعنی موعد گذشته. هشدارها در داشبورد هم دیده می‌شوند.</small></div>
      </div>
      <p className="muted small g-note"><Icon name="info" />قطعه‌ای که اضافه می‌کنید هم در «نگهداری پیشگیرانه» و هم در «قطعات جایگزین» دیده می‌شود. با «حذف قطعه‌ها» می‌توانید یک یا چند قطعه را با هم حذف کنید؛ سوابق تعویض در تاریخچه ماشین باقی می‌ماند.</p>
    </section>

    <div className="grid-2">
      <section className="card g-sec"><div className="g-sec-h"><span className="g-badge">۴</span><div><h3>تعریف‌ها کجاست؟</h3><p>همه تعریف‌ها در یک جا: <b>تنظیمات و تعاریف</b>.</p></div></div>
        <ul className="g-list"><li><Icon name="truck" /><b>ماشین‌ها</b><span>نام، نوع، پلاک، مدل، راننده، سرپرست، مسئول PM و واحد کارکرد</span></li><li><Icon name="users" /><b>پرسنل</b><span>رانندگان، سرپرستان و مسئولین PM</span></li><li><Icon name="layers" /><b>مدل‌ها</b><span>هر مدل فهرست قطعات خودش را دارد</span></li><li><Icon name="route" /><b>مراحل وضعیت</b><span>نام، ترتیب و تعداد مراحل؛ افزودن یا حذف مرحله و حد مجاز روز هر مرحله</span></li><li><Icon name="gavel" /><b>قوانین اقدامات مدیریتی</b><span>اقدام متناسب با تعداد دفعات سهل‌انگاری</span></li></ul>
      </section>
      <section className="card g-sec"><div className="g-sec-h"><span className="g-badge">۵</span><div><h3>سوابق کجا می‌ماند؟</h3><p>هیچ سابقه‌ای خودبه‌خود پاک نمی‌شود.</p></div></div>
        <ul className="g-list"><li><Icon name="archive" /><b>بایگانی تعمیرات</b><span>همه پرونده‌هایی که تست سلامتشان ثبت شده، با نتیجه قبول یا رد</span></li><li><Icon name="history" /><b>تاریخچه کامل ماشین</b><span>در «پرونده ماشین‌ها» روی هر ماشین بزنید: خرابی‌ها، مرحله‌ها، تست‌ها، تحلیل‌ها، تعویض قطعات و کارکرد</span></li><li><Icon name="database-backup" /><b>پشتیبان سرور</b><span>نسخه‌های پشتیبان را مدیرکل از بخش «پشتیبان‌گیری» دریافت می‌کند.</span></li></ul>
      </section>
    </div>

    <section className="card g-rules"><h3><Icon name="sparkles" />قانون‌های طلایی</h3><div>
      <span><Icon name="check" />هر خرابی فقط از «اعلام خرابی» شروع می‌شود.</span><span><Icon name="check" />هیچ مرحله‌ای جا نمی‌افتد؛ سامانه مرحله بعد را تا ثبت مرحله قبل قفل نگه می‌دارد.</span><span><Icon name="check" />هیچ ماشینی بدون «تست سلامت» در کارخانه سالم اعلام نمی‌شود.</span><span><Icon name="check" />اگر تست رد شد، خرابی جدید وصل به پرونده قبلی ثبت شود، نه خرابی جدا.</span>
    </div></section>
  </div>;
}
