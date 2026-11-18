const { strict: assert } = require('node:assert');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { readFile, readdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { Pool } = require('pg');

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const defaultChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const chromeExecutable = process.env.CHROME_BIN || (process.platform === 'win32' && existsSync(defaultChrome) ? defaultChrome : undefined);
const apiPort = Number(process.env.SMOKE_API_PORT || 55300);
const webPort = Number(process.env.SMOKE_WEB_PORT || 55301);
const appUrl = `http://127.0.0.1:${webPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;

async function waitUntilReady(url, process) {
  for (let i = 0; i < 40; i++) {
    if (process.exitCode !== null) throw new Error(`Process stopped before serving ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Service did not start at ${url}`);
}

async function capturePage(page, path) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const sidebars=page.locator('.sidebar .nav');
  if(await sidebars.count())await sidebars.first().evaluate(element=>{element.querySelector(':focus')?.blur();element.scrollTop=0;});
  await page.waitForTimeout(150);
  await page.screenshot({ path, fullPage: true });
}

async function run() {
  const connectionString = process.env.DATABASE_URL;
  assert(connectionString, 'DATABASE_URL is required');
  const schema = 'smoke_' + randomBytes(8).toString('hex');
  const password = randomBytes(18).toString('base64url');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 3000 });
  const children = [];
  let browser;
  let schemaCreated = false;
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    const isolated = new URL(connectionString);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    const migration = new Pool({ connectionString: isolated.href });
    try {
      const migrations = (await readdir(resolve(__dirname, '../infra/migrations')))
        .filter(filename => /^\d{3}_.+\.sql$/.test(filename)).sort();
      for (const filename of migrations) await migration.query(await readFile(resolve(__dirname, '../infra/migrations', filename), 'utf8'));
      const seeded = await migration.query('SELECT count(*)::int AS machines FROM machines');
      assert.equal(seeded.rows[0].machines, 11);
    } finally {
      await migration.end();
    }
    const api = spawn(process.execPath, ['dist/main.js'], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(apiPort), DATABASE_URL: isolated.href, SEPID_ADMIN_USERNAME: 'smoke-admin', SEPID_ADMIN_PASSWORD: password, SMS_PROVIDER: 'mock' },
      stdio: 'inherit',
    });
    children.push(api);
    await waitUntilReady(apiUrl + '/api/v1/health/ready', api);
    const openApiResponse = await fetch(apiUrl + '/api/v1/openapi.json');
    assert.equal(openApiResponse.status, 200, 'OpenAPI document should be public for tooling');
    const openApi = await openApiResponse.json();
    assert.equal(openApi.openapi, '3.1.0');
    assert.equal(openApi.servers[0].url, '/', 'OpenAPI paths already include the API version prefix');
    assert.ok(openApi.paths['/api/v1/repairs/{id}/events/undo']?.post, 'OpenAPI should describe repair history reversal');
    assert.ok(openApi.paths['/api/v1/repairs/diagnosers']?.get, 'OpenAPI should describe permission-checked diagnoser suggestions');
    assert.ok(openApi.paths['/api/v1/sms/recipients']?.get, 'OpenAPI should describe permission-checked SMS recipients');
    assert.ok(openApi.paths['/api/v1/auth/password']?.post, 'OpenAPI should describe authenticated self-service password rotation');
    assert.deepEqual(openApi.paths['/api/v1/auth/login'].post.security, [], 'login must not require an existing session');
    assert.ok(openApi.paths['/api/v1/repairs'].post.parameters.some(parameter => parameter.name === 'x-sepid-request'), 'mutations should document the required request header');
    const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
      cwd: resolve(__dirname, '../../frontend'),
      env: { ...process.env, SEPID_API_URL: apiUrl },
      stdio: 'inherit',
    });
    children.push(web);
    await waitUntilReady(appUrl, web);
    assert.equal((await fetch(appUrl + '/api/v1/machines')).status, 401);
    browser = await chromium.launch(chromeExecutable ? { executablePath: chromeExecutable } : {});
    const page = await browser.newPage();
    const pageErrors=[];
    page.on('pageerror',error=>pageErrors.push(error.stack||error.message));
    page.on('response', async response => {
      if (response.status() >= 400 && response.request().method() === 'POST' && /\/repairs\/[^/]+\/events$/.test(response.url())) {
        console.log(`Repair stage response ${response.status()}: ${await response.text()}`);
      }
    });
    page.setDefaultTimeout(8000);
    await page.goto(appUrl);
    assert.match(await page.locator('link[rel="icon"]').getAttribute('href'), /^data:image\/svg\+xml,/);
    await page.getByRole('heading', { name: 'ورود به سامانه' }).waitFor();
    await page.screenshot({ path: resolve(__dirname, '../../frontend/login-desktop.png') });
    await page.getByRole('checkbox', { name: 'این دستگاه را به خاطر بسپار' }).check();
    await page.getByLabel('نام کاربری').fill('smoke-admin');
    for (let attempt = 1; attempt <= 5; attempt++) {
      await page.getByLabel('رمز عبور').fill(`${password}_wrong`);
      await page.getByRole('button', { name: 'ورود', exact: true }).click();
      if (attempt < 5) await page.getByRole('alert').filter({hasText:'نام کاربری یا رمز عبور نادرست است.'}).waitFor();
      else await page.getByRole('alert').filter({hasText:'پس از ۵ بار رمز اشتباه، حساب برای ۱۵ دقیقه قفل شد.'}).waitFor();
    }
    await pool.query(`UPDATE ${schema}.users SET failed_login_attempts=0,login_locked_until=NULL WHERE username='smoke-admin'`);
    await page.getByLabel('رمز عبور').fill(password);
    await page.getByRole('button', { name: 'ورود', exact: true }).click();
    await page.getByRole('heading', { name: 'مقایسه نتایج بر اساس ماشین' }).waitFor();
    assert.ok((await pool.query(`SELECT last_login FROM ${schema}.users WHERE username='smoke-admin'`)).rows[0].last_login,'successful login should save the last-login timestamp');
    const replacementPassword=randomBytes(20).toString('hex');
    await page.getByRole('button',{name:'تغییر رمز من'}).click();
    const passwordDialog=page.getByRole('dialog',{name:'تغییر رمز من'});
    await passwordDialog.waitFor();
    await page.screenshot({path:resolve(__dirname,'../../frontend/password-dialog-desktop.png')});
    await passwordDialog.getByLabel('رمز فعلی').fill(`${password}_wrong`);
    await passwordDialog.getByLabel('رمز جدید',{exact:true}).fill(replacementPassword);
    await passwordDialog.getByLabel('تکرار رمز جدید',{exact:true}).fill(replacementPassword);
    await passwordDialog.getByRole('button',{name:'ذخیره رمز'}).click();
    await passwordDialog.getByRole('alert').filter({hasText:'رمز فعلی درست نیست'}).waitFor();
    await passwordDialog.getByLabel('رمز فعلی').fill(password);
    await passwordDialog.getByRole('button',{name:'ذخیره رمز'}).click();
    await page.getByRole('status').filter({hasText:'رمز عبور با موفقیت تغییر کرد'}).waitFor();
    assert.equal((await page.request.get(appUrl+'/api/v1/auth/me')).status(),200,'password change should preserve the current browser session');
    const initialFleet=await (await page.request.get(appUrl+'/api/v1/machines')).json();
    assert.equal(initialFleet.length,11,'paired visual captures should start with the same seeded fleet records as the legacy interface');
    await page.locator('.toasts').waitFor({state:'hidden'});
    await page.setViewportSize({width:1280,height:900});
    const visualPairs=[
      {react:'داشبورد',legacy:'#/dashboard',heading:'داشبورد بررسی علائم و عملکرد خودرو',name:'dashboard'},
      {react:'پرونده ماشین‌ها',legacy:'#/machines',heading:'پرونده ماشین‌ها',name:'machines'},
      {react:'وضعیت ماشین‌ها',legacy:'#/status',heading:'وضعیت ماشین‌ها',name:'status'},
      {react:'خرابی‌های در جریان',legacy:'#/repairs',heading:'خرابی‌های در جریان',name:'repairs'},
      {react:'نگهداری پیشگیرانه',legacy:'#/maint',heading:'نگهداری پیشگیرانه',name:'maintenance'},
      {react:'قطعات و جایگزین‌ها',legacy:'#/parts',heading:'قطعات جایگزین',name:'parts'},
      {react:'تحلیل‌های خرابی',legacy:'#/analyses',heading:'تحلیل‌های خرابی',name:'analyses'},
      {react:'اقدامات مدیریتی',legacy:'#/people',heading:'اقدامات مدیریتی',name:'actions'},
      {react:'پرسنل',legacy:'#/settings/people',reactHeading:'تنظیمات و تعاریف',legacyHeading:'تنظیمات و تعاریف',name:'people'},
      {react:'کاربران و دسترسی‌ها',legacy:'#/users',heading:'کاربران و دسترسی‌ها',legacyHeading:false,name:'users'},
      {react:'تنظیمات و تعاریف',legacy:'#/settings',heading:'تنظیمات و تعاریف',name:'settings'},
      {react:'تنظیمات و گزارش پیامک',legacy:'#/sms',reactHeading:'پیامک',legacyHeading:false,name:'sms'},
      {react:'بایگانی تعمیرات',legacy:'#/archive',heading:'بایگانی تعمیرات',name:'archive'},
      {react:'رویه کار با سامانه',legacy:'#/guide',reactHeading:'رویه کار با سامانه ناوگان',legacyHeading:'رویه کار با سامانه ناوگان',name:'guide'},
    ];
    let reactDashboardGeometry;
    let reactMaintenanceGeometry;
    let reactGuideGeometry;
    let reactPartsModelHeight;
    let reactRepairSummaryRadius;
    const reactFullHeights={};
    for(const pair of visualPairs){
      if(pair.name!=='dashboard') { const item=page.getByRole('button',{name:pair.react,exact:true}); await item.scrollIntoViewIfNeeded(); await item.click(); }
      await page.getByRole('heading',{name:pair.reactHeading??pair.heading,exact:true}).waitFor();
      await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);document.querySelector('.view')?.scrollTo(0,0);});
      if(pair.name==='dashboard'){
        await page.locator('.dashboard-bottom-grid > section:first-child .notice').waitFor();
        assert.equal(await page.locator('.dashboard-bottom-grid > section:first-child .notice .ic').count(),1,'missing-usage guidance should match the legacy dashboard');
        assert.equal(await page.locator('.kpi-total .kpi-sub').innerText(),'هنوز بررسی‌ای ثبت نشده','empty total KPI should use the legacy guidance instead of a meaningless zero percent');
        assert.equal(await page.locator('.dashboard-page .head-acts>.link').evaluate(element=>getComputedStyle(element).borderTopWidth),'0px','the legacy dashboard uses a text link beside the quick action, not a bordered button');
        assert.equal(await page.locator('.dashboard-empty-bars .chart-xlabel tspan').count(),12,'machine chart labels should split the make and model onto two lines like the legacy reference');
        reactDashboardGeometry=await page.evaluate(()=>Object.fromEntries([['rep','.dashboard-page > .rep-board'],['title','.dashboard-page > .dash-sec'],['filters','.dashboard-page > .dashboard-filters'],['kpis','.dashboard-page > .kpis'],['charts','.dashboard-page > .dashboard-charts'],['bottom','.dashboard-page .dashboard-bottom-grid'],['suggestion','.dashboard-page .dashboard-suggestion']].map(([key,selector])=>{const rect=document.querySelector(selector).getBoundingClientRect();return [key,{top:rect.top,height:rect.height}]})));
      }
      if(pair.name==='repairs') { reactRepairSummaryRadius=await page.locator('.sum-tiles .sum-tile').first().evaluate(element=>getComputedStyle(element).borderRadius);assert.equal(await page.locator('.sum-tiles .sum-tile span .ic').count(),5,'repair summary tiles should use reference status icons'); }
      if(pair.name==='machines') { await page.locator('.machine-card').first().waitFor(); assert.equal(await page.locator('.machine-card').count(),11,'React visual fixture should show all seeded machines');const directorySummary=page.locator('.directory-management>summary');assert.match(await directorySummary.getAttribute('class'),/visually-hidden/,'the directory disclosure label should stay accessible without showing a duplicate heading');assert.match(await directorySummary.textContent(),/مدیریت تعاریف/,'machine directory should replace the browser default English label with a Persian accessible name');assert.doesNotMatch(await directorySummary.textContent(),/Details/); }
      if(pair.name==='parts') { const filterHeight=await page.locator('.parts-filters').evaluate(element=>element.getBoundingClientRect().height);assert.ok(filterHeight<=70,`parts filter bar should match the compact legacy control row; got ${filterHeight}px`);reactPartsModelHeight=await page.locator('.parts-model-tab').first().evaluate(element=>element.getBoundingClientRect().height); }
      if(pair.name==='maintenance') { await page.locator('.maint-pick').first().waitFor(); assert.equal(await page.locator('.maint-pick').count(),11,'maintenance visual fixture should include all seeded machines'); assert.equal(await page.locator('.mpk-go').count(),11,'machine cards should use a chevron icon like the legacy page'); assert.equal(await page.locator('.mpk-tags .ic').count(),11,'maintenance status chips should retain their reference icons');reactMaintenanceGeometry=await page.evaluate(()=>Object.fromEntries(['.howto','.maint-grid','.maint-grid .maint-pick:last-child'].map(selector=>{const element=document.querySelector(selector);const rect=element.getBoundingClientRect();return[selector,{top:rect.top+window.scrollY,height:rect.height}]}))); }
      if(pair.name==='actions') { await page.locator('.management-person-card').first().waitFor();const order=await page.locator('.management-group').first().locator('.management-person-head b').allTextContents();assert.deepEqual(order,['علی محمدی','عبدالحمید ترت زاد','سعید صدیقی','محمود محمدی','صلاح الدین شهبازجو','محمود فریدی','محمد غفوری'],'management action cards should keep the legacy person order');assert.equal(await page.locator('.management-group').last().locator('.management-machine-codes').count(),0,'supervisor cards should show the assigned-vehicle count instead of listing every vehicle');assert.equal(await page.locator('.management-person-card .st-good').count(),8,'no-negligence states should retain their green reference badge');assert.equal(await page.locator('.management-rule-item>strong[data-action-tone]').count(),7,'management rules should use color-coded action pills'); }
      if(pair.name==='guide') reactGuideGeometry=await page.locator('.guide').evaluate(element=>Array.from(element.children).map(child=>({kind:child.className,top:child.getBoundingClientRect().top+window.scrollY,height:child.getBoundingClientRect().height})));
      if(pair.name==='repairs') { await page.getByRole('heading',{name:'خرابی بازی وجود ندارد'}).waitFor();const actionPositions=await page.locator('.repair-view .page-head .ph-actions button').evaluateAll(elements=>elements.map(element=>({name:element.innerText.trim(),left:element.getBoundingClientRect().left})).sort((a,b)=>a.left-b.left).map(item=>item.name));assert.deepEqual(actionPositions,['بایگانی','چاپ گزارش','خروجی اکسل'],'repair page actions should have the same visual order as the legacy page');assert.equal(await page.getByRole('button',{name:'چاپ گزارش',exact:true}).isDisabled(),false,'the legacy print action remains available when the repair list is empty');assert.equal(await page.getByRole('button',{name:'خروجی اکسل',exact:true}).isDisabled(),false,'the legacy export action remains available when the repair list is empty'); }
      if(pair.name==='analyses') { await page.getByRole('heading',{name:'هنوز تحلیلی ثبت نشده'}).waitFor();assert.equal(await page.getByRole('button',{name:'چاپ گزارش',exact:true}).isDisabled(),false,'the legacy print action remains available when the analysis list is empty');assert.equal(await page.getByRole('button',{name:'خروجی اکسل (CSV)',exact:true}).isDisabled(),false,'the legacy export action remains available when the analysis list is empty'); }
      if(pair.name==='people') { assert.equal(await page.locator('[aria-label="جست‌وجو و فیلتر پرسنل"]').count(),0,'the legacy directory has no extra search-filter panel above its grouped tables');assert.equal(await page.getByText(/نمایش\s+\d+\s+از\s+\d+\s+نفر/).count(),0,'the legacy people list relies on per-role counts in group headers');const firstPerson=page.locator('.people-directory-group tbody tr').first();assert.equal(await firstPerson.locator('.avatar').innerText(),'ع‌م','people avatars should use the first and last name initials separated by the legacy zero-width non-joiner');assert.match(await firstPerson.locator('.avatar').getAttribute('style')||'',/--h:\s*\d+/,'people avatars should use the legacy name-derived color'); }
      if(pair.name==='status') { assert.equal(await page.getByText(/نمایش\s+\d+\s+از\s+\d+\s+پروندهٔ باز/).count(),0,'the legacy status page does not add a duplicate open-case count between filters and the empty state');assert.equal(await page.locator('.status-filters .chip.on').first().evaluate(element=>getComputedStyle(element).borderRadius),'999px','status filter buttons should retain the reference pill shape'); }
      await capturePage(page,resolve(__dirname,`../../frontend/visual-react-baseline-${pair.name}.png`));
      if(pair.name==='guide')reactGuideGeometry=await page.locator('.guide').evaluate(element=>Array.from(element.children).map(child=>({kind:child.className,top:child.getBoundingClientRect().top+window.scrollY,height:child.getBoundingClientRect().height})));
      if(pair.name==='maintenance')reactMaintenanceGeometry=await page.evaluate(()=>Object.fromEntries(['.howto','.maint-grid','.maint-grid .maint-pick:last-child'].map(selector=>{const element=document.querySelector(selector);const rect=element.getBoundingClientRect();return[selector,{top:rect.top+window.scrollY,height:rect.height}]})));
      if(['dashboard','actions','people','guide','status','maintenance'].includes(pair.name))reactFullHeights[pair.name]=await page.evaluate(()=>Math.max(document.documentElement.scrollHeight,document.body.scrollHeight));
      await page.goto(`${appUrl}/legacy-online.html${pair.legacy}`);
      if(pair.legacyHeading!==false) await page.getByRole('heading',{name:pair.legacyHeading??pair.heading,exact:true}).waitFor();
      await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);document.querySelector('#app')?.scrollTo(0,0);});
      if(pair.name==='machines') { await page.locator('.machine-card').first().waitFor(); assert.equal(await page.locator('.machine-card').count(),11,'legacy visual fixture should show the same eleven seeded machines'); }
      if(pair.name==='parts'){const legacyHeight=await page.locator('.model-tab').first().evaluate(element=>element.getBoundingClientRect().height);assert.ok(Math.abs(reactPartsModelHeight-legacyHeight)<=2,`parts model cards should match legacy height; React=${reactPartsModelHeight}, legacy=${legacyHeight}`);}
      if(pair.name==='dashboard'){
        const legacyGeometry=await page.evaluate(()=>Object.fromEntries([['rep','.rep-board'],['title','.dash-sec'],['filters','.filters.card'],['kpis','.kpis'],['charts','.charts'],['bottom','.grid-2:last-of-type'],['suggestion','.fleet .recs']].map(([key,selector])=>{const rect=document.querySelector(selector).getBoundingClientRect();return [key,{top:rect.top,height:rect.height}]})));
        console.log('Dashboard layout comparison (React vs legacy): '+JSON.stringify(Object.fromEntries(Object.keys(legacyGeometry).map(key=>[key,{topDelta:Number((reactDashboardGeometry[key].top-legacyGeometry[key].top).toFixed(2)),heightDelta:Number((reactDashboardGeometry[key].height-legacyGeometry[key].height).toFixed(2))}]))));
        for(const key of ['rep','title','filters','kpis','charts','bottom']){
          const reactKey=key==='rep'?'rep':key;
          const difference=Math.abs(reactDashboardGeometry[reactKey].top-legacyGeometry[key].top);
          assert.ok(difference<=5,`dashboard ${key} should start within 5px of the legacy reference; React=${reactDashboardGeometry[reactKey].top}, legacy=${legacyGeometry[key].top}`);
        }
        for(const key of ['kpis','charts']){
          const difference=Math.abs(reactDashboardGeometry[key].height-legacyGeometry[key].height);
          assert.ok(difference<=5,`dashboard ${key} height should stay within 5px of the legacy reference; React=${reactDashboardGeometry[key].height}, legacy=${legacyGeometry[key].height}`);
        }
        const suggestionHeightDifference=Math.abs(reactDashboardGeometry.suggestion.height-legacyGeometry.suggestion.height);
        assert.ok(suggestionHeightDifference<=3,`dashboard suggestions should match the legacy card height within 3px; React=${reactDashboardGeometry.suggestion.height}, legacy=${legacyGeometry.suggestion.height}`);
      }
      if(pair.name==='repairs')assert.equal(reactRepairSummaryRadius,await page.locator('.sum-tiles .sum-tile').first().evaluate(element=>getComputedStyle(element).borderRadius),'repair summary cards should match legacy corner radius');
      if(pair.name==='maintenance'){
        await capturePage(page,resolve(__dirname,'../../frontend/visual-legacy-baseline-maintenance.png'));
        const legacyMaintenanceGeometry=await page.evaluate(()=>Object.fromEntries(['.howto','.maint-grid','.maint-grid .maint-pick:last-child'].map(selector=>{const element=document.querySelector(selector);const rect=element.getBoundingClientRect();return[selector,{top:rect.top+window.scrollY,height:rect.height}]})));
        for(const selector of ['.howto','.maint-grid','.maint-grid .maint-pick:last-child']){const topDelta=Math.abs(reactMaintenanceGeometry[selector].top-legacyMaintenanceGeometry[selector].top);assert.ok(topDelta<=3,`maintenance ${selector} should start within 3px of legacy; delta=${topDelta}`);assert.ok(Math.abs(reactMaintenanceGeometry[selector].height-legacyMaintenanceGeometry[selector].height)<=2,`maintenance ${selector} height should match the legacy reference`);}
      }
      if(pair.name==='guide'){
        await capturePage(page,resolve(__dirname,'../../frontend/visual-legacy-baseline-guide.png'));
        const legacyGuideGeometry=await page.locator('.guide').evaluate(element=>Array.from(element.children).map(child=>({kind:child.className,top:child.getBoundingClientRect().top+window.scrollY,height:child.getBoundingClientRect().height})));
        for(let index=0;index<reactGuideGeometry.length;index++){const topDelta=Math.abs(reactGuideGeometry[index].top-legacyGuideGeometry[index].top);assert.ok(topDelta<=2,`guide section ${index+1} should start within 2px of legacy; delta=${topDelta}`);assert.ok(Math.abs(reactGuideGeometry[index].height-legacyGuideGeometry[index].height)<=2,`guide section ${index+1} height should match legacy`);}
      }
      await capturePage(page,resolve(__dirname,`../../frontend/visual-legacy-baseline-${pair.name}.png`));
      if(pair.name in reactFullHeights){const legacyHeight=await page.evaluate(()=>Math.max(document.documentElement.scrollHeight,document.body.scrollHeight));const delta=Math.abs(reactFullHeights[pair.name]-legacyHeight);const limit=['guide','maintenance'].includes(pair.name)?3:2;assert.ok(delta<=limit,`${pair.name} full-page height should be within ${limit}px of the legacy reference; React=${reactFullHeights[pair.name]}, legacy=${legacyHeight}`);}
      await page.goto(appUrl);
      await page.getByRole('heading',{name:'داشبورد بررسی علائم و عملکرد خودرو'}).waitFor();
    }
    const legacyReferencePage=await browser.newPage();
    await legacyReferencePage.goto(`${appUrl}/legacy/original/fleet-single-file.html`);
    await legacyReferencePage.getByRole('heading',{name:'راه‌اندازی اولیه'}).waitFor();
    await legacyReferencePage.getByLabel('نام کاربری مدیر کل').fill('legacy-reference-admin');
    await legacyReferencePage.getByLabel('رمز عبور',{exact:true}).fill(randomBytes(18).toString('base64url'));
    const legacyPassword=await legacyReferencePage.getByLabel('رمز عبور',{exact:true}).inputValue();
    await legacyReferencePage.getByLabel('تکرار رمز عبور').fill(legacyPassword);
    await legacyReferencePage.getByRole('button',{name:'ذخیره و ورود'}).click();
    await legacyReferencePage.getByRole('heading',{name:'داشبورد بررسی علائم و عملکرد خودرو'}).waitFor();
    await legacyReferencePage.goto(`${appUrl}/legacy/original/fleet-single-file.html#/users`);
    await legacyReferencePage.getByRole('heading',{name:'کاربران و دسترسی‌ها'}).waitFor();
    await capturePage(legacyReferencePage,resolve(__dirname,'../../frontend/visual-legacy-admin-users.png'));
    await legacyReferencePage.goto(`${appUrl}/legacy/original/fleet-single-file.html#/sms`);
    await legacyReferencePage.getByRole('heading',{name:'پیامک',exact:true}).waitFor();
    await capturePage(legacyReferencePage,resolve(__dirname,'../../frontend/visual-legacy-admin-sms.png'));
    await legacyReferencePage.close();
    await page.locator('.nav').getByRole('button',{name:'خرابی‌های در جریان',exact:true}).click();
    await page.getByRole('heading',{name:'خرابی بازی وجود ندارد'}).waitFor();
    await page.locator('.top-actions').getByRole('button',{name:'اعلام خرابی',exact:true}).click();
    await page.getByRole('heading',{name:'اعلام خرابی جدید'}).waitFor();
    assert.equal(await page.locator('.repair-create-form .machine-choice').count(),11,'general repair form should show all eleven seeded machines');
    const diagnoserList=page.locator('#repair-diagnoser-options option');
    await diagnoserList.first().waitFor({state:'attached'});
    assert((await page.locator('#repair-diagnoser-options').evaluate(node=>Array.from(node.options,option=>option.value))).includes('عبدالکریم موغفاری'),
      'repair form should offer active supervisor names from the shared people directory');
    assert.equal(await page.locator('.urgency-choice.selected').count(),0,'the legacy repair form starts without a preselected urgency');
    assert.equal(await page.locator('.repair-create-form label').filter({hasText:'تاریخ اعلام خرابی'}).locator('.req').count(),1,'the legacy repair form marks the report date as required');
    assert.equal(await page.locator('.repair-create-form label').filter({hasText:'نوع خرابی'}).locator('.req').count(),1,'the legacy repair form marks the repair description as required');
    await capturePage(page,resolve(__dirname,'../../frontend/repair-create-react.png'));
    await page.goto(`${appUrl}/legacy-online.html#/repairs/new`);
    await page.getByLabel('نوع خرابی').waitFor();
    await capturePage(page,resolve(__dirname,'../../frontend/repair-create-legacy.png'));
    await page.goto(appUrl);
    await page.getByRole('heading',{name:'داشبورد بررسی علائم و عملکرد خودرو'}).waitFor();
    await page.locator('.nav').getByRole('button',{name:'تحلیل‌های خرابی',exact:true}).click();
    await page.getByRole('heading',{name:'هنوز تحلیلی ثبت نشده'}).waitFor();
    await page.locator('.page-head').getByRole('button',{name:'تحلیل جدید',exact:true}).click();
    await page.getByRole('heading',{name:'ثبت تحلیل خرابی جدید'}).waitFor();
    await capturePage(page,resolve(__dirname,'../../frontend/analysis-wizard-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/analyses/new`);
    await page.getByLabel('موضوع خرابی').waitFor();
    await capturePage(page,resolve(__dirname,'../../frontend/analysis-wizard-legacy.png'));
    await page.goto(appUrl);
    await page.getByRole('heading',{name:'داشبورد بررسی علائم و عملکرد خودرو'}).waitFor();
    await pool.query(`DELETE FROM ${schema}.machines; DELETE FROM ${schema}.people; DELETE FROM ${schema}.machine_models`);
    await pool.query(`INSERT INTO ${schema}.people(id,name,role,phone) VALUES('p8','عبدالکریم موغفاری','supervisor','09120000008'),('p9','مسئول نگهداری آزمایشی','pm','09120000009')`);
    await page.reload();
    await page.getByRole('heading',{name:'هنوز تحلیلی ثبت نشده'}).waitFor();
    await page.setViewportSize({width:1280,height:720});
    assert.equal(await page.locator('.dashboard-heading .toolbar').count(),0,'dashboard title area should match the legacy layout without extra print or refresh actions');
    assert.deepEqual(await page.locator('.nav-group .nav-title').allInnerTexts(),['نمای کلی','کار روزانه','تعمیرات و ماشین‌ها','نگهداری و قطعات','تحلیل و اقدامات مدیریتی','بایگانی و مدیریت سامانه'],'sidebar groups should follow the legacy order');
    assert.deepEqual(await page.locator('.top-actions button').evaluateAll(elements=>elements.map(element=>element.getAttribute('aria-label')||element.innerText.trim())),['تغییر پوسته','تحلیل جدید','اعلام خرابی'],'top actions should follow the legacy order');
    assert.equal(await page.locator('.top-actions .btn-new .ic').count(),2,'quick actions should retain the legacy icons');
    assert.equal(await page.locator('.fleet-search kbd').innerText(),'Ctrl K','global search should show the legacy shortcut hint');
    assert.equal(await page.locator('.top-actions').getByRole('button',{name:'ثبت مرحله بعد'}).count(),0,'stage updates belong in the daily-work navigation group');
    for (const [result,token] of [['driver','--c-driver'],['pm','--c-pm'],['both','--c-both'],['none','--c-none']]) {
      const colors=await page.locator(`.kpi-${result}`).evaluate((element,variable)=>({actual:getComputedStyle(element).getPropertyValue('--kc').trim(),expected:getComputedStyle(document.documentElement).getPropertyValue(variable).trim()}),token);
      assert.equal(colors.actual,colors.expected,`${result} KPI should use the legacy result color`);
    }
    await page.locator('.dashboard-machine-legend').getByText('سهل‌انگاری راننده').waitFor();
    await page.getByRole('heading', { name: 'هنوز تحلیلی ثبت نشده' }).waitFor();
    await page.getByRole('button', { name: 'ثبت اولین تحلیل' }).waitFor();
    assert.equal(await page.locator('.rep-board .calm .ic').count(),1,'empty repair summary should retain the legacy healthy-state icon');
    await page.locator('.dashboard-bottom-grid > section:first-child .calm').getByText('هیچ قطعه‌ای نزدیک یا گذشته از موعد نیست.').waitFor();
    await page.locator('.dashboard-actions-card .calm .ic').waitFor();
    const emptyDashboardCharts=page.locator('.dashboard-data-chart');
    await emptyDashboardCharts.first().waitFor();
    assert.equal(await emptyDashboardCharts.count(),2,'empty dashboard should keep both chart frames visible');
    assert.equal(await emptyDashboardCharts.nth(0).locator('.chart-xlabel').count(),0,'empty machine chart should not invent vehicle labels when the fleet itself is empty');
    assert.equal(await emptyDashboardCharts.nth(0).locator('.chart-tick').count(),5,'empty machine chart should keep the same five reference axis ticks');
    assert.equal(await emptyDashboardCharts.nth(0).locator('path').count(),0,'empty machine chart should not draw phantom result bars');
    assert.equal(await emptyDashboardCharts.nth(1).locator('circle').count(),24,'empty monthly chart should show both zero series for all months');
    assert.equal(await emptyDashboardCharts.nth(1).locator('.chart-xlabel').count(),12,'empty monthly chart should keep all twelve month labels');
    await page.getByRole('button',{name:'خرابی‌های در جریان',exact:true}).click();
    await page.getByRole('heading',{name:'خرابی‌های در جریان'}).waitFor();
    assert.deepEqual(await page.locator('.repair-view .page-head .ph-actions button').allInnerTexts(),['خروجی اکسل','چاپ گزارش','بایگانی']);
    await page.getByRole('heading',{name:'خرابی بازی وجود ندارد'}).waitFor();
    await page.getByText('همه خرابی‌ها تست سلامت شده و در بایگانی‌اند.').waitFor();
    await page.locator('.repair-view .empty').getByRole('button',{name:'اعلام خرابی'}).waitFor();
    assert.equal(await page.locator('.repair-view').getByText(/نمایش\s+۰\s+از\s+۰/).count(),0,'empty repair state should not show an extra result count');
    const repairTileStyle=await page.locator('.repair-view .sum-tile').first().evaluate(element=>({paddingBlockStart:getComputedStyle(element).paddingBlockStart,paddingInlineStart:getComputedStyle(element).paddingInlineStart,countSize:getComputedStyle(element.querySelector('b')).fontSize}));
    assert.deepEqual(repairTileStyle,{paddingBlockStart:'12px',paddingInlineStart:'16px',countSize:'28px'},'repair summary tiles should use the legacy spacing and count size at every viewport');
    assert.equal(await page.locator('.repair-view .empty h4').evaluate(element=>getComputedStyle(element).marginBlockStart),'0px','repair empty headings should keep the legacy zero margin');
    assert.equal(await page.getByPlaceholder('نوع خرابی، تعمیرگاه، مسئول تشخیص…').count(),1);
    const openStageOptions=await page.locator('.repair-filter-grid select').nth(1).locator('option').allTextContents();
    assert.equal(openStageOptions.some(label=>label.includes('تست سلامت')),false,'the open-repair stage filter must not offer the terminal health-test stage');
    await page.getByRole('button',{name:'داشبورد'}).click();
    await page.getByRole('heading',{name:'مقایسه نتایج بر اساس ماشین'}).waitFor();
    await page.getByRole('button',{name:'ثبت مرحله بعد'}).click();
    await page.getByRole('heading',{name:'وضعیت ماشین‌ها'}).waitFor();
    await page.getByRole('heading',{name:'انتخاب پرونده برای ثبت مرحلهٔ بعد'}).waitFor();
    await page.getByText('فقط تأخیردارها',{exact:true}).waitFor();
    const statusChips=await page.locator('.status-filters .chip').allInnerTexts();
    assert.equal(statusChips[0],'همه (۰)');
    assert.equal(statusChips.at(-1),'فقط تأخیردارها');
    const typeChips=statusChips.slice(1,-1);
    const orderedTypeChips=[...typeChips].sort((a,b)=>{
      const order=['ده تن','لودر','تراکتور'];const ai=order.indexOf(a),bi=order.indexOf(b);
      if(ai>=0||bi>=0)return (ai<0?order.length:ai)-(bi<0?order.length:bi);
      return a.localeCompare(b,'fa');
    });
    assert.deepEqual(typeChips,orderedTypeChips,'available machine type filters should follow legacy order');
    const stageLegend=await page.locator('.status-stage-legend').innerText();
    assert.match(stageLegend,/اعلام خرابی \(ماشین در کارخانه\).*خرابی ثبت شده و ماشین هنوز در کارخانه است/s);
    assert.match(stageLegend,/تعمیر تمام شده و ماشین باید در کارخانه تست سلامت شود/);
    assert.doesNotMatch(stageLegend,/مسئول ثبت/);
    await page.getByRole('button',{name:'داشبورد'}).click();
    await page.getByRole('heading',{name:'مقایسه نتایج بر اساس ماشین'}).waitFor();
    await page.getByRole('button', { name: 'رویه کار با سامانه' }).click();
    await page.getByRole('heading', { name: 'رویه کار با سامانه ناوگان' }).waitFor();
    await page.getByText('تست سلامت قبول شد').waitFor();
    await page.getByText('پشتیبان سرور').waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/guide-desktop.png'));
    await page.getByRole('button', { name: 'انتقال دادهٔ نسخهٔ قبلی' }).click();
    await page.getByRole('heading', { name: 'انتقال دادهٔ نسخهٔ قبلی' }).waitFor();
    await page.getByText(/هنوز فایل پشتیبان نسخهٔ قبلی روی سرور نیست/).waitFor();
    const migrationText = await page.locator('.view').innerText();
    assert.match(migrationText, /هنوز فایل پشتیبان نسخهٔ قبلی روی سرور نیست/, migrationText);
    await page.goto(appUrl + '/legacy-online.html#/backup');
    assert.match(await page.locator('link[rel="icon"]').getAttribute('href'), /^data:image\/svg\+xml,/);
    await page.getByRole('button', { name: 'دریافت فایل پشتیبان' }).waitFor();
    const legacyBackupDownload=page.waitForEvent('download');
    await page.getByRole('button', { name: 'دریافت فایل پشتیبان' }).click();
    const legacyBackupPath=await (await legacyBackupDownload).path();
    assert(legacyBackupPath,'legacy backup download must produce a file');
    await page.locator('#restoreFile').setInputFiles(legacyBackupPath);
    await page.getByRole('button', { name: 'بازیابی شود' }).click();
    await page.getByText('اطلاعات با موفقیت بازیابی شد').waitFor();
    await page.goto(appUrl);
    await page.getByRole('button', { name: 'رویه کار با سامانه' }).waitFor();
    await page.getByRole('button', { name: 'انتقال دادهٔ نسخهٔ قبلی' }).click();
    await page.getByText('موارد موجود در پشتیبان').waitFor();
    const importedBackupPreview=await page.locator('.view').innerText();
    assert.match(importedBackupPreview,/ماشین/);
    assert.match(importedBackupPreview,/پشتیبان قابل انتقال است|پیش از انتقال باید بررسی شود/);
    await page.getByRole('button', { name: 'پشتیبان‌های سرور' }).click();
    await page.getByRole('heading', { name: 'پشتیبان‌های پایگاه داده' }).waitFor();
    await page.getByText('هنوز نسخهٔ پشتیبانی در مخزن سرور پیدا نشد.').waitFor();
    await pool.query(`UPDATE ${schema}.users SET phone='09120000000',receive_sms=true WHERE username='smoke-admin'`);
    await pool.query(`INSERT INTO ${schema}.users(id,username,name,active,is_super_admin,phone,receive_sms) VALUES('sms-recipient','smoke-sms-recipient','گیرنده پیامک آزمایشی',true,false,'09120000001',true)`);
    const smsRule={on:true,to:['all'],text:'پرونده «ماشین» · «مرحله»'};
    await pool.query(`UPDATE ${schema}.app_settings SET payload=payload || $1::jsonb WHERE singleton`,[JSON.stringify({smsStageAlerts:true,smsRules:{report:smsRule,wait:smsRule,done:smsRule,test:smsRule}})]);
    await page.getByRole('button', { name: 'پرونده ماشین‌ها' }).click();
    const loginCookie = (await page.context().cookies()).find(cookie => cookie.name === 'sepid_session');
    assert(loginCookie?.httpOnly && loginCookie.expires > Date.now() / 1000);
    await page.locator('.page-head').getByRole('button', { name: 'تعریف و ویرایش ماشین‌ها' }).click();
    assert.equal(await page.locator('#machine-directory-management').evaluate(element=>element.open),true,'the legacy machine-definition action should reveal the directory editor');
    await page.getByRole('button', { name: 'ثبت مدل' }).click();
    await page.getByLabel('نام مدل').fill('مدل آزمایشی');
    await page.getByLabel('برند').fill('سپید');
    await page.getByRole('button', { name: 'ذخیره اطلاعات پایه' }).click();
    await page.getByText('اطلاعات پایه ذخیره شد.').waitFor();
    await page.getByRole('button', { name: 'ثبت پرسنل' }).click();
    await page.getByLabel('نام پرسنل').fill('راننده آزمایشی');
    await page.getByRole('button', { name: 'ذخیره اطلاعات پایه' }).click();
    await page.getByText('اطلاعات پایه ذخیره شد.').waitFor();
    await page.getByRole('button', { name: 'ویرایش مدل' }).click();
    await page.getByLabel('نام مدل').fill('مدل آزمایشی ویرایش');
    await page.getByRole('button', { name: 'ذخیره اطلاعات پایه' }).click();
    await page.getByText('اطلاعات پایه ذخیره شد.').waitFor();
    await page.getByRole('button', { name: 'ثبت مدل' }).click();
    await page.getByLabel('نام مدل').fill('مدل حذف آزمایشی');
    await page.getByRole('button', { name: 'ذخیره اطلاعات پایه' }).click();
    await page.getByText('اطلاعات پایه ذخیره شد.').waitFor();
    const disposableModel = page.locator('.directory-management tbody tr').filter({hasText:'مدل حذف آزمایشی'});
    page.once('dialog', dialog => dialog.accept());
    await disposableModel.getByRole('button', { name: 'حذف مدل' }).click();
    await disposableModel.waitFor({ state: 'detached' });
    await page.locator('.directory-management tbody tr').filter({hasText:'راننده آزمایشی'}).getByRole('button', { name: 'ویرایش پرسنل' }).click();
    await page.getByLabel('نام پرسنل').fill('راننده آزمایشی ویرایش');
    await page.getByLabel('تلفن').fill('09120000000');
    await page.getByRole('button', { name: 'ذخیره اطلاعات پایه' }).click();
    await page.getByText('اطلاعات پایه ذخیره شد.').waitFor();
    await page.getByRole('button', { name: 'ثبت ماشین' }).click();
    await page.getByLabel('کد ماشین').fill('SMOKE-01');
    await page.getByLabel('نوع ماشین').fill('تست مرورگر');
    await page.getByLabel('پلاک').fill('۱۲الف۳۴۵');
    await page.getByLabel('مدل ماشین').selectOption({ label: 'مدل آزمایشی ویرایش' });
    await page.getByLabel('راننده', { exact: true }).selectOption({ label: 'راننده آزمایشی ویرایش' });
    await page.getByRole('button', { name: 'ذخیره پرونده' }).click();
    await page.getByText('پرونده ذخیره شد.').waitFor();
    const assignedModel = page.locator('.directory-management tbody tr').filter({hasText:'مدل آزمایشی ویرایش'});
    assert.equal(await assignedModel.getByRole('button', { name: 'حذف مدل' }).isDisabled(), true, 'a model assigned to a machine cannot be deleted');
    await page.reload();
    await page.getByRole('button', { name: 'پرونده ماشین‌ها' }).click();
    await page.locator('.machine-card').filter({ hasText: 'SMOKE-01' }).waitFor();
    await page.locator('.machine-card').filter({ hasText: 'SMOKE-01' }).click();
    await page.getByRole('button', { name: 'ویرایش مشخصات', exact: true }).click();
    await page.getByLabel('کد ماشین').fill('SMOKE-02');
    await page.getByRole('button', { name: 'ذخیره پرونده' }).click();
    await page.getByRole('heading', { name: 'SMOKE-02' }).waitFor();
    await page.locator('.machine-profile-specs').getByText('راننده آزمایشی ویرایش',{exact:true}).waitFor();
    await page.getByRole('heading',{name:'لیست اقدامات مدیریتی راننده'}).waitFor();
    await page.getByRole('heading',{name:'لیست اقدامات مدیریتی مسئول PM'}).waitFor();
    await page.locator('.machine-profile-head').getByRole('button',{name:/اعلام خرابی/}).click();
    const preselectedMachine=page.locator('.machine-choice[aria-pressed="true"]');
    await preselectedMachine.waitFor();
    assert.match(await preselectedMachine.innerText(),/SMOKE-02/,'machine detail should preselect its vehicle in a new repair');
    await page.getByRole('button',{name:'انصراف'}).click();
    await page.getByRole('button',{name:'خرابی‌های در جریان'}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('select option')].some(option=>option.value==='SMOKE-02'));
    assert.equal(await page.locator('select option[value="SMOKE-02"]').count(),1,'repair machine filter should include the full fleet');
    const repairStageFilter=page.locator('select').filter({has:page.locator('option[value="__late"]')});
    assert.equal(await page.locator('select option[value="__late"]').count(),1,'the repair status filter should include the legacy delay option');
    await repairStageFilter.selectOption('__late');
    assert.equal(await repairStageFilter.evaluate(element=>element.value),'__late');
    await repairStageFilter.selectOption('');
    await page.getByRole('button',{name:'پرونده ماشین‌ها'}).click();
    await page.locator('.machine-card').filter({ hasText: 'SMOKE-02' }).waitFor();
    const machineCard=page.locator('.machine-card').filter({ hasText: 'SMOKE-02' });
    await machineCard.getByText('راننده آزمایشی ویرایش').waitFor();
    await machineCard.getByText('تحلیل‌ها').waitFor();
    assert.match(await machineCard.locator('.mc-model').getAttribute('class'),/\bmdl-/,'machine cards should preserve the legacy model class hook');
    await machineCard.getByText('۰ سهل‌انگاری',{exact:true}).waitFor();
    await page.getByRole('button',{name:'داشبورد'}).click();
    await page.getByText(/کارکرد فعلی ۱ ماشین هنوز ثبت نشده/).waitFor();
    assert.equal(await page.getByText('هشدار نگهداری فعالی ثبت نشده است.',{exact:true}).count(),0);
    await page.getByRole('button',{name:'پرونده ماشین‌ها'}).click();
    await page.locator('.machine-card').filter({hasText:'SMOKE-02'}).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/machines-desktop.png'));
    const result = await pool.query(
      `SELECT m.code, m.version, model.name AS model, person.name AS driver
       FROM ${schema}.machines m JOIN ${schema}.machine_models model ON m.model_id = model.id
       JOIN ${schema}.people person ON m.driver_id = person.id`,
    );
    assert.deepEqual(result.rows, [{ code: 'SMOKE-02', version: 2, model: 'مدل آزمایشی ویرایش', driver: 'راننده آزمایشی ویرایش' }]);
    await page.locator('.machine-card').filter({ hasText: 'SMOKE-02' }).click();
    await page.getByRole('article', { name: 'پروندهٔ ماشین SMOKE-02' }).waitFor();
    await page.getByRole('heading', { name: 'تاریخچه کامل ماشین (بایگانی)' }).waitFor();
    const machineProfileSections=await page.locator('.machine-profile-list h3').allTextContents();
    assert.match(machineProfileSections[0],/^لیست اقدامات مدیریتی\s*راننده/,'driver actions should lead the machine profile');
    assert.match(machineProfileSections[1],/^لیست اقدامات مدیریتی\s*مسئول PM/,'PM actions should follow driver actions');
    assert.deepEqual(machineProfileSections.slice(2).map(value=>value.trim()),[
      'خرابی‌ها و تعمیرات این ماشین','تحلیل‌های خرابی این ماشین','کارکرد فعلی','وضعیت قطعات',
    ],'machine detail sections should follow the legacy order');
    assert.equal(await page.locator('.machine-profile-repairs').count(),1,'repairs should occupy the full-width row in the legacy machine profile');
    assert.equal(await page.locator('.machine-profile-lower-grid .machine-profile-analysis').count(),1,'analysis should share the lower status row');
    assert.equal(await page.locator('#machine-full-history').getByRole('button',{name:'چاپ'}).isEnabled(),true,'empty machine history can still be printed like the legacy page');
    await page.locator('.machine-profile-breadcrumb').click();
    await page.getByRole('button', { name: 'وضعیت ماشین‌ها' }).click();
    await page.locator('.status-healthy span button').filter({hasText:'SMOKE-02'}).click();
    await page.getByRole('article', { name: 'پروندهٔ ماشین SMOKE-02' }).waitFor();
    await page.locator('.machine-profile-breadcrumb').click();
    await page.getByRole('button', { name: 'وضعیت ماشین‌ها' }).click();
    await page.getByRole('button', { name: 'خرابی‌های در جریان' }).click();
    await page.locator('.top-actions').getByRole('button', { name: 'اعلام خرابی', exact: true }).click();
    await page.getByRole('heading',{name:'اعلام خرابی جدید'}).waitFor();
    assert.equal(await page.locator('.repair-list-content').count(),0,'repair creation should replace the list like the dedicated legacy form route');
    await page.locator('.nav').getByRole('button', { name: 'خرابی‌های در جریان',exact:true }).click();
    await page.locator('.top-actions').getByRole('button', { name: 'اعلام خرابی', exact: true }).click();
    const repairMachineChoice=page.locator('.machine-pick').getByRole('button', { name: /SMOKE-02/ });
    assert.match(await repairMachineChoice.innerText(),/مدل آزمایشی ویرایش[\s\S]*SMOKE-02/);
    assert.match(await repairMachineChoice.innerText(),/تست مرورگر/);
    await repairMachineChoice.click();
    await page.locator('.urgency-pick').getByRole('button', { name: /۱ تا ۳ روز/ }).click();
    assert.equal(await page.locator('.urgency-pick').getByRole('button', { name: /۱ تا ۳ روز/ }).getAttribute('aria-pressed'), 'true');
    await page.getByLabel('تاریخ اعلام خرابی').fill('۱۴۰۵/۰۸/۱۰');
    await page.getByLabel('نوع خرابی').fill('خرابی آزمایشی');
    await page.getByRole('button', { name: 'ثبت خرابی',exact:true }).click();
    await page.waitForFunction(()=>!document.querySelector('.repair-create-form'),{timeout:8000}).catch(async()=>{throw new Error(`repair form did not save; alerts=${JSON.stringify(await page.locator('[role="alert"]').allInnerTexts())}`);});
    await page.getByRole('heading', { name: 'تاریخچهٔ مراحل' }).waitFor();
    assert.equal((await pool.query(`SELECT urgency FROM ${schema}.repairs WHERE title='خرابی آزمایشی'`)).rows[0].urgency, 'd13');
    assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format((await pool.query(`SELECT report_date FROM ${schema}.repairs WHERE title='خرابی آزمایشی'`)).rows[0].report_date),'2026-11-01','Persian date input should persist the matching Gregorian API date');
    const detail = page.getByRole('article', { name: 'جزئیات خرابی' });
    const repairFormPrint=page.waitForEvent('popup');
    await detail.getByRole('button',{name:'چاپ فرم پرونده'}).click();
    const repairFormPrintPage=await repairFormPrint;
    await repairFormPrintPage.getByRole('heading',{name:'فرم اعلام خرابی و پیگیری تعمیر'}).waitFor();
    await repairFormPrintPage.locator('.box').filter({hasText:'خرابی آزمایشی'}).first().waitFor();
    await repairFormPrintPage.getByText('تاریخچهٔ مراحل').waitFor();
    await repairFormPrintPage.close();
    await page.getByRole('button', { name: 'پرونده ماشین‌ها' }).click();
    await page.locator('.machine-card').filter({ hasText: 'SMOKE-02' }).click();
    await page.getByText(/پروندهٔ 1 · خرابی آزمایشی · اعلام خرابی/).waitFor();
    const machineTimeline=page.locator('.machine-timeline');
    const repairHistoryFilter=machineTimeline.getByRole('button', { name: /خرابی و تعمیر/ });
    await repairHistoryFilter.waitFor();
    await repairHistoryFilter.click();
    assert.equal(await repairHistoryFilter.getAttribute('aria-pressed'), 'true');
    assert.equal(await machineTimeline.getByRole('button', { name: /^چاپ$/ }).isDisabled(), false);
    await machineTimeline.getByRole('button', { name: /^همه/ }).click();
    await page.locator('.machine-profile-breadcrumb').click();
    await page.getByRole('button', { name: 'خرابی‌های در جریان' }).click();
    await page.getByLabel('خلاصهٔ خرابی‌های باز').waitFor();
    await page.getByRole('button', { name: /دارای تأخیر/ }).waitFor();
    await page.getByRole('button', { name: /دارای تأخیر/ }).click();
    const repairListRow=page.locator('tr').filter({hasText:'خرابی آزمایشی'}).first();
    await repairListRow.waitFor();
    await repairListRow.locator('.urg-serious').waitFor();
    await repairListRow.locator('.st-crit').waitFor();
    assert.match(await repairListRow.getAttribute('class')??'',/rep-late/);
    await page.getByRole('button', { name: /دارای تأخیر/ }).click();
    await page.getByRole('button', { name: 'وضعیت ماشین‌ها' }).click();
    const activeStatusCard=page.locator('.status-card').filter({hasText:'خرابی آزمایشی'});
    await activeStatusCard.waitFor();
    await activeStatusCard.getByText(/تأخیر در ارجاع/).waitFor();
    await activeStatusCard.getByText(/زمان در مرحلهٔ فعلی/).waitFor();
    await activeStatusCard.getByText(/ثبت‌کننده:/).waitFor();
    await page.getByRole('button', { name: /^همه \(/ }).waitFor();
    assert.equal(await page.locator('.status-filters > .chip .ic').count(), 1, 'the delayed-only filter should show the legacy clock icon');
    assert.equal(await page.locator('.status-filters .chips-meta .ic').count(), 1, 'the last-status timestamp should show the legacy clock icon');
    const statusNavigationBadge=page.locator('.sidebar .nav-item').filter({hasText:'وضعیت ماشین‌ها'}).locator('.nav-badge');
    await statusNavigationBadge.waitFor();
    assert.equal((await statusNavigationBadge.textContent())?.trim(),'۱','the sidebar should show the number of open fleet repairs');
    assert.ok(await statusNavigationBadge.evaluate(element=>element.classList.contains('crit')),'late fleet repairs should use the critical badge color');
    assert.notEqual(await page.locator('.status-page .ph-actions .btn-primary').evaluate(button=>getComputedStyle(button).backgroundColor),'rgb(255, 255, 255)', 'the primary stage action should retain the brand color inside page content');
    await page.waitForTimeout(350);
    await capturePage(page, resolve(__dirname, '../../frontend/status-desktop.png'));
    await activeStatusCard.getByRole('button',{name:/جزئیات و تاریخچه/}).click();
    await page.locator('.status-detail').getByRole('heading',{name:'تاریخچهٔ وضعیت'}).waitFor();
    await page.locator('.status-detail').getByRole('button',{name:'بستن'}).click();
    await page.getByRole('main').locator('.page-head .ph-actions').getByRole('button',{name:'ثبت مرحله بعد',exact:true}).click();
    await page.getByRole('heading',{name:'انتخاب پرونده برای ثبت مرحلهٔ بعد'}).waitFor();
    await page.getByRole('button',{name:/SMOKE-02 · پروندهٔ 1/}).click();
    await page.locator('.status-detail').getByRole('heading',{name:'تاریخچهٔ وضعیت'}).waitFor();
    await page.locator('.status-detail').getByRole('button',{name:'بستن'}).click();
    await page.getByRole('button', { name: 'خرابی‌های در جریان' }).click();
    await page.getByRole('cell',{name:'خرابی آزمایشی'}).waitFor();
    const repairFilterPanel=page.locator('.repair-filter-grid.open');
    const repairFilterRows=await repairFilterPanel.locator(':scope > label').evaluateAll(elements=>elements.map(element=>Math.round(element.getBoundingClientRect().top)));
    assert.equal(repairFilterRows.length,6,'the open-repair view should retain all six legacy filters');
    assert.equal(new Set(repairFilterRows.slice(0,4)).size,1,'the four primary repair filters should share the first row');
    assert.equal(repairFilterRows[4],repairFilterRows[5],'the two date filters should share the second row');
    assert(repairFilterRows[4]>repairFilterRows[0],'date filters should wrap below the primary filters like the legacy screen');
    assert.equal(await repairFilterPanel.locator('.repair-search-input .ic').count(),1,'the repair search filter should show the legacy search icon');
    assert.equal(await repairFilterPanel.getByRole('button',{name:'پاک‌کردن فیلترها'}).count(),0,'the clear-filters action should stay hidden until a filter is changed');
    await repairFilterPanel.getByLabel('جستجو').fill('خرابی');
    await repairFilterPanel.getByRole('button',{name:'پاک‌کردن فیلترها'}).click();
    assert.equal(await repairFilterPanel.getByLabel('جستجو').evaluate(element=>element.value),'','clearing filters should restore the default query');
    await capturePage(page, resolve(__dirname, '../../frontend/repairs-desktop.png'));
    const openRepairCsv=page.waitForEvent('download');
    await page.getByRole('button',{name:'خروجی اکسل'}).click();
    const openRepairFile=await openRepairCsv;
    assert.equal(openRepairFile.suggestedFilename(),'خرابی-های-درجریان.csv');
    assert.match(await readFile(await openRepairFile.path(),'utf8'),/خرابی آزمایشی/);
    const openRepairPrint=page.waitForEvent('popup');
    await page.getByRole('button',{name:'چاپ گزارش'}).click();
    const openRepairPrintPage=await openRepairPrint;
    await openRepairPrintPage.getByText('خرابی آزمایشی').waitFor();
    await openRepairPrintPage.close();
    await page.getByRole('button',{name:'بایگانی تعمیرات',exact:true}).click();
    await page.getByRole('heading',{name:'بایگانی تعمیرات'}).waitFor();
    await page.getByRole('heading',{name:'بایگانی هنوز خالی است'}).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/archive-empty-desktop.png'));
    assert.equal(await page.getByRole('cell',{name:'خرابی آزمایشی'}).count(),0,'open repairs should not appear in the archive');
    await page.getByRole('button',{name:'خرابی‌های در جریان'}).click();
    await page.getByRole('cell',{name:'خرابی آزمایشی'}).waitFor();
    await page.getByRole('button',{name:'جزئیات',exact:true}).first().click();
    await page.getByRole('heading', { name: 'تاریخچهٔ مراحل' }).waitFor();
    const next = detail.getByRole('button', { name: 'ثبت مرحلهٔ بعد' });
    await detail.getByLabel('تعمیرگاه یا تعمیرکار').fill('تعمیرگاه تست مرورگر');
    await detail.getByLabel('قطعه یا خدمت مورد انتظار').fill('پمپ تست مرورگر');
    await detail.getByLabel('وضعیت تأمین').selectOption('shipping');
    await detail.getByLabel('فروشنده یا محل تأمین').fill('فروشنده تست');
    await detail.getByLabel('تحویل تقریبی قطعه یا خدمت').fill('2026-11-15');
    await detail.getByLabel('موعد پیش‌بینی پایان تعمیر').fill('2026-11-19');
    await next.click();
    await detail.getByText(/SMOKE-02 · در انتظار قطعه یا خدمات/).waitFor();
    await detail.getByText(/پمپ تست مرورگر/).waitFor();
    await detail.getByLabel('قطعه یا خدمت مورد انتظار').fill('پمپ تست مرورگر، مرحلهٔ دوم');
    assert.equal(await detail.getByLabel('قطعه یا خدمت مورد انتظار').inputValue(),'پمپ تست مرورگر، مرحلهٔ دوم');
    await detail.getByLabel('وضعیت تأمین').selectOption('arrived');
    const repeatResponsePromise=page.waitForResponse(response=>/\/repairs\/[^/]+\/events$/.test(new URL(response.url()).pathname)&&response.request().method()==='POST');
    await detail.getByRole('button',{name:'ثبت به‌روزرسانی همین مرحله'}).click();
    const repeatResponse=await repeatResponsePromise;
    assert.equal(repeatResponse.status(),201,await repeatResponse.text());
    await detail.getByText('پمپ تست مرورگر، مرحلهٔ دوم',{exact:false}).waitFor();
    page.once('dialog',dialog=>dialog.accept());
    const undoRepeatPromise=page.waitForResponse(response=>response.url().includes('/events/undo')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'برگرداندن آخرین ثبت'}).click();
    const undoRepeatResponse=await undoRepeatPromise;
    assert.equal(undoRepeatResponse.status(),201,await undoRepeatResponse.text());
    assert.equal((await undoRepeatResponse.json()).stage,'wait');
    await detail.locator('li.voided-event').waitFor();
    assert.equal(await detail.getByLabel('قطعه یا خدمت مورد انتظار').inputValue(),'پمپ تست مرورگر');
    await detail.getByLabel('قطعه یا خدمت مورد انتظار').fill('پمپ تست مرورگر، مرحلهٔ دوم');
    await detail.getByLabel('وضعیت تأمین').selectOption('arrived');
    const retryRepeatPromise=page.waitForResponse(response=>/\/repairs\/[^/]+\/events$/.test(new URL(response.url()).pathname)&&response.request().method()==='POST');
    await detail.getByRole('button',{name:'ثبت به‌روزرسانی همین مرحله'}).click();
    const retryRepeat=await retryRepeatPromise;
    assert.equal(retryRepeat.status(),201,await retryRepeat.text());
    await detail.getByText('پمپ تست مرورگر، مرحلهٔ دوم',{exact:false}).last().waitFor();
    await next.click();
    await page.waitForTimeout(400);
    const stageError = page.getByRole('alert');
    if (await stageError.count()) throw new Error(`Could not advance repair: ${await stageError.first().innerText()}`);
    await detail.getByRole('heading', { name: 'تست سلامت' }).waitFor();
    await next.click();
    await detail.getByLabel('نتیجهٔ تست').selectOption('pass');
    await next.click();
    await page.getByRole('heading', { name: 'بایگانی تعمیرات', exact: true }).waitFor();
    await page.getByRole('button', { name: 'وضعیت ماشین‌ها' }).click();
    await page.getByRole('heading', { name: 'وضعیت ماشین‌ها' }).waitFor();
    await page.getByRole('heading', { name: 'سالم و در حال کار', exact: true }).waitFor();
    assert.equal(await page.locator('.status-metrics .status-tile span .ic').count(),4,
      'status summary tiles should keep the legacy location icons');
    const statusCountStyle=await page.locator('.status-metrics .status-tile b').first().evaluate(element=>({
      fontSize:getComputedStyle(element).fontSize,color:getComputedStyle(element).color,bodyColor:getComputedStyle(document.body).color,
    }));
    assert.equal(statusCountStyle.fontSize,'26px','status summary counts should keep the legacy size');
    assert.equal(statusCountStyle.color,statusCountStyle.bodyColor,'status summary counts should use the legacy neutral text color');
    const healthyOrder=(await pool.query(`SELECT m.code FROM ${schema}.machines m WHERE m.active
      AND NOT EXISTS(SELECT 1 FROM ${schema}.repairs r WHERE r.machine_id=m.id AND r.result IS NULL)
      ORDER BY m.sort_order,m.id`)).rows.map(row=>row.code);
    assert.deepEqual(await page.locator('.status-healthy button').allTextContents(),healthyOrder,
      'the healthy fleet chips should follow the stored legacy machine order');
    await page.reload();
    await page.getByRole('button', { name: 'خرابی‌های در جریان' }).click();
    await page.getByRole('button', { name: 'رفتن به بایگانی تعمیرات' }).click();
    await page.getByLabel('خلاصهٔ بایگانی تعمیرات').waitFor();
    await page.getByRole('button', { name: /تست سلامت قبول/ }).click();
    await page.getByRole('columnheader', { name: 'تکمیل تست' }).waitFor();
    await page.getByRole('cell', { name: 'خرابی آزمایشی' }).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/archive-desktop.png'));
    const archiveCsv=page.waitForEvent('download');
    await page.getByRole('button', { name: 'خروجی CSV' }).click();
    assert.match((await archiveCsv).suggestedFilename(),/^بایگانی-تعمیرات\.csv$/);
    await page.getByRole('button',{name:'جزئیات',exact:true}).first().click();
    page.once('dialog',dialog=>dialog.accept());
    const undoResponsePromise=page.waitForResponse(response=>response.url().includes('/events/undo')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'برگرداندن آخرین ثبت'}).click();
    const undoResponse=await undoResponsePromise;
    assert.equal(undoResponse.status(),201,await undoResponse.text());
    const undone=await undoResponse.json();
    assert.equal(undone.stage,'done');
    await page.getByRole('button',{name:'برگرداندن آخرین ثبت'}).waitFor({state:'detached'});
    const events = await pool.query(`SELECT stage, result, voided_at FROM ${schema}.repair_events ORDER BY revision`);
    assert.deepEqual(events.rows, [
      { stage: 'report', result: null, voided_at: null }, { stage: 'wait', result: null, voided_at: null },
      { stage: 'wait', result: null, voided_at: events.rows[2]?.voided_at }, { stage: 'wait', result: null, voided_at: null },
      { stage: 'done', result: null, voided_at: null }, { stage: 'test', result: 'pass', voided_at: events.rows[5]?.voided_at },
    ]);
    assert(events.rows[2].voided_at);
    assert(events.rows[5].voided_at);
    assert.match(await detail.innerText(),/لغوشده/);
    const waitDetails=(await pool.query(`SELECT details FROM ${schema}.repair_events WHERE stage='wait' ORDER BY revision DESC LIMIT 1`)).rows[0].details;
    assert.equal(waitDetails.part_name,'پمپ تست مرورگر، مرحلهٔ دوم');
    assert.equal(waitDetails.part_status,'arrived');
    assert.equal(waitDetails.part_vendor,'فروشنده تست');
    assert.equal(waitDetails.part_eta,'2026-11-15');
    for (let i=0;i<20;i++) {
      const queued = await pool.query(`SELECT count(*)::int AS total FROM ${schema}.sms_messages WHERE status IN ('queued','sending')`);
      if (queued.rows[0].total === 0) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS total FROM ${schema}.sms_messages WHERE status='accepted' AND message LIKE 'پرونده %'`)).rows[0].total, 5);
    await pool.query(`UPDATE ${schema}.sms_messages SET created_at=now()-interval '2 minutes' WHERE created_by=(SELECT id FROM ${schema}.users WHERE username='smoke-admin')`);
    await page.getByRole('button', { name: 'قطعات و جایگزین‌ها' }).click();
    await page.getByRole('button', { name: 'افزودن قطعه', exact: true }).waitFor();
    await page.locator('.parts-model-tab').first().waitFor();
    assert(await page.locator('.parts-model-tab').count()>0,'part catalog should show selectable model cards');
    assert.equal(await page.locator('.parts-model-tab[aria-pressed="true"]').count(),1,'the first model should be selected when the catalog opens');
    const firstPartModel=await page.locator('.parts-model-tab').first().innerText();
    assert.match(firstPartModel,/مدل آزمایشی ویرایش/,'models should be ordered by their first fleet machine');
    assert.match(firstPartModel,/SMOKE-02/,'model cards should show assigned fleet machine codes');
    assert.doesNotMatch(firstPartModel,/NaN|بدون ماشین/,'model counts and machine assignments must be present');
    await page.getByRole('heading',{name:/هنوز قطعه‌ای برای/}).waitFor();
    await page.getByRole('button',{name:'افزودن اولین قطعه',exact:true}).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/parts-desktop.png'));
    await page.getByRole('button', { name: 'نگهداری پیشگیرانه' }).click();
    await page.locator('.maint-pick').filter({hasText:'SMOKE-02'}).click();
    await page.getByRole('heading',{name:'هنوز قطعه‌ای برای مدل «مدل آزمایشی ویرایش» تعریف نشده'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'خروجی',exact:true}).count(),1,'the machine maintenance page should keep the legacy export action available even when empty');
    assert.equal(await page.getByRole('button',{name:'افزودن قطعه',exact:true}).count(),1,'editable users should be able to add a part from maintenance');
    assert.equal(await page.locator('.maint-top .maintenance-state-tiles .sum-tile').count(),4,'maintenance should match the legacy four status summaries beside the odometer card');
    assert.equal(await page.getByText('قطعه‌ای با این فیلترها پیدا نشد.',{exact:true}).count(),0,'an empty model should not show the generic filtered-results empty state as well');
    await page.getByRole('button',{name:'افزودن اولین قطعه',exact:true}).click();
    await page.getByLabel('نام قطعه',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('مدل قطعه').locator('option:checked').textContent(),'مدل آزمایشی ویرایش','adding from maintenance should preselect the selected vehicle model');
    await page.getByRole('button',{name:'انصراف',exact:true}).click();
    await page.getByRole('button', { name: 'قطعات و جایگزین‌ها' }).click();
    await page.getByRole('button', { name: 'افزودن قطعه', exact: true }).waitFor();
    await page.getByRole('button', { name: 'افزودن قطعه', exact: true }).click();
    await page.getByLabel('نام قطعه', { exact: true }).fill('فیلتر آزمایشی');
    await page.locator('select[name="system"]').selectOption('eng');
    await page.getByLabel('دوره کیلومتری').fill('1000');
    await page.getByRole('button', { name: 'ذخیره قطعه' }).click();
    await page.getByRole('heading', { name: 'فیلتر آزمایشی' }).waitFor();
    await page.getByRole('button', { name: 'ثبت جایگزین' }).click();
    await page.getByLabel('نام قطعه جایگزین').fill('جایگزین آزمایشی');
    await page.getByRole('button', { name: 'ذخیره جایگزین' }).click();
    await page.getByText('جایگزین آزمایشی', { exact: false }).waitFor();
    await page.locator('.parts-alternatives-switch').click();
    assert.equal(await page.getByLabel('فقط دارای جایگزین').isChecked(),true,'the visible alternatives switch should enable its checkbox');
    await page.getByLabel('جست‌وجوی قطعه یا جایگزین').fill('جایگزین آزمایشی');
    await page.locator('.part-alternative-row').filter({hasText:'جایگزین آزمایشی'}).waitFor();
    const partsCsv=page.waitForEvent('download');
    await page.getByRole('button',{name:'خروجی',exact:true}).click();
    assert.match((await partsCsv).suggestedFilename(),/قطعات-جایگزین\.csv$/);
    await page.getByLabel('جست‌وجوی قطعه یا جایگزین').fill('');
    await page.locator('.parts-alternatives-switch').click();
    assert.equal(await page.getByLabel('فقط دارای جایگزین').isChecked(),false,'the visible alternatives switch should disable its checkbox');
    const editablePart = page.locator('.parts-catalog article.record').filter({ hasText: 'فیلتر آزمایشی' }).first();
    const editableAlternative=editablePart.locator('.part-alternative-row').filter({hasText:'جایگزین آزمایشی'});
    await editableAlternative.getByRole('button',{name:'ویرایش جایگزین'}).click();
    await page.getByLabel('تأمین‌کننده').fill('تأمین‌کنندهٔ ویرایش‌شده');
    await page.getByLabel('توضیحات جایگزین').fill('توضیح ویرایش‌شده');
    await page.getByLabel('تأیید شده').check();
    await page.getByRole('button',{name:'ذخیره جایگزین'}).click();
    await page.getByRole('status').filter({hasText:'جایگزین ذخیره شد'}).waitFor();
    const editedAlternative=editablePart.locator('.part-alternative-row').filter({hasText:'تأمین‌کنندهٔ ویرایش‌شده'});
    page.once('dialog',dialog=>dialog.accept());
    await editedAlternative.getByRole('button',{name:'حذف جایگزین'}).click();
    await page.getByRole('status').filter({hasText:'جایگزین حذف شد'}).waitFor();
    await editablePart.getByRole('button', { name: 'ویرایش' }).click();
    await page.getByLabel('نوع اقدام').selectOption('s');
    await page.getByLabel('تبعات انجام‌ندادن به‌موقع').fill('پیامد ویرایش‌شده');
    await page.getByRole('button', { name: 'ذخیره تغییرات قطعه' }).click();
    await page.getByText('پیامد ویرایش‌شده', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'نگهداری پیشگیرانه' }).click();
    await page.getByText('آخرین تعویض هر قطعه را وارد کنید').waitFor();
    assert.equal(await page.locator('.page-head').getByText('ماشین را انتخاب کنید تا همه قطعاتش همراه با دوره تعویض و وضعیت فعلی نمایش داده شود.',{exact:true}).count(),1,'the maintenance page should match the legacy overview subtitle');
    assert.equal(await page.getByText('برای شروع، یک ماشین فعال ثبت کنید.',{exact:true}).count(),0,'an empty-fleet prompt should not appear while machine cards are available');
    await page.waitForTimeout(350);
    await capturePage(page, resolve(__dirname, '../../frontend/maintenance-desktop.png'));
    await page.locator('.maint-pick').filter({hasText:'SMOKE-02'}).waitFor();
    await page.locator('.maint-pick').filter({hasText:'SMOKE-02'}).click();
    await page.locator('.sys-head').getByRole('heading',{name:'موتور'}).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/maintenance-machine-desktop.png'));
    await page.getByRole('button',{name:'همهٔ ماشین‌ها'}).click();
    await page.getByText('آخرین تعویض هر قطعه را وارد کنید').waitFor();
    await page.locator('.maint-pick').filter({hasText:'SMOKE-02'}).click();
    await page.locator('.sys-head').getByRole('heading',{name:'موتور'}).waitFor();
    const intervalPartsTab=page.getByRole('tab',{name:/قطعات دوره‌ای/});
    await intervalPartsTab.click();
    assert.equal(await intervalPartsTab.getAttribute('aria-selected'),'true');
    const allPartsTab=page.getByRole('tab',{name:/^همه/});
    await allPartsTab.click();
    assert.equal(await allPartsTab.getAttribute('aria-selected'),'true');
    const firstServiceRow=page.locator('.maint-table tbody tr').first();
    await firstServiceRow.getByRole('button',{name:'ثبت',exact:true}).click();
    await page.getByRole('dialog',{name:/ثبت (سرویس|تعویض):/}).waitFor();
    assert.equal(await page.getByLabel('قطعه سرویس').count(),0,'registering from a part row should retain the chosen part like the legacy flow');
    await capturePage(page, resolve(__dirname, '../../frontend/maintenance-service-modal.png'));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({state:'detached'});
    await page.getByRole('button', { name: 'ثبت سرویس یا تعویض' }).click();
    await page.getByRole('dialog', { name: /ثبت سرویس/ }).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/maintenance-service-create-modal.png'));
    await page.getByLabel('مقدار کارکرد').fill('100');
    await page.getByRole('dialog').getByRole('button', { name: 'ثبت', exact: true }).click();
    await page.getByRole('cell', { name: 'در موعد', exact: true }).waitFor();
    await page.getByRole('button', { name: 'ثبت سرویس یا تعویض' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({state:'detached'});
    await page.getByRole('button', { name: 'ثبت سرویس اولیه' }).click();
    const bulkPart = page.locator('.maintenance-bulk-list input[type="checkbox"]').first();
    const bulkParts = page.locator('.maintenance-bulk-list input[type="checkbox"]');
    await page.getByRole('button', { name: 'هیچ‌کدام' }).click();
    assert.equal(await page.locator('.maintenance-bulk-list input[type="checkbox"]:checked').count(), 0);
    await page.getByRole('button', { name: 'فقط ثبت‌نشده‌ها' }).click();
    const maintenanceMachineId=await page.locator('.maintenance-machine-tabs').getAttribute('data-selected-machine');
    const unrecordedParts=await page.evaluate(async id=>{
      const response=await fetch('/api/v1/maintenance');
      const data=await response.json();
      return data.parts.filter(part=>part.machine_id===id&&!part.last_date).length;
    },maintenanceMachineId);
    assert.equal(await page.locator('.maintenance-bulk-list input[type="checkbox"]:checked').count(),unrecordedParts);
    await page.getByRole('button', { name: 'انتخاب همه' }).click();
    assert.equal(await page.locator('.maintenance-bulk-list input[type="checkbox"]:checked').count(), await bulkParts.count());
    await page.getByRole('button', { name: 'هیچ‌کدام' }).click();
    await bulkPart.check();
    await page.getByRole('dialog').getByRole('button', { name: 'ثبت برای موارد انتخاب‌شده', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'سابقهٔ سرویس اولیه ذخیره شد' }).waitFor();
    const maintenanceCsv = page.waitForEvent('download');
    await page.locator('.page-head').getByRole('button', { name: 'خروجی',exact:true }).click();
    assert.match((await maintenanceCsv).suggestedFilename(), /^نگهداری-SMOKE-02\.csv$/);
    await page.getByRole('columnheader', { name: 'باقی‌مانده' }).waitFor();
    await page.getByRole('columnheader', { name: 'آخرین سرویس یا تعویض' }).waitFor();
    await page.getByRole('button', { name: 'به‌روزرسانی', exact: true }).click();
    await page.getByLabel('مقدار کارکرد').fill('1050');
    await page.getByRole('dialog').getByRole('button', { name: 'ثبت', exact: true }).click();
    await page.getByRole('cell', { name: 'نزدیک موعد', exact: true }).waitFor();
    await page.getByRole('button', { name: 'به‌روزرسانی', exact: true }).click();
    await page.getByLabel('مقدار کارکرد').fill('1200');
    await page.getByRole('dialog').getByRole('button', { name: 'ثبت', exact: true }).click();
    await page.getByRole('cell', { name: 'گذشته از موعد', exact: true }).waitFor();
    const firstMaintenancePart=page.locator('.maint-table tbody tr').first();
    await firstMaintenancePart.getByRole('button',{name:'سوابق'}).click();
    await page.getByRole('heading',{name:/سوابق:/}).waitFor();
    await page.getByRole('button',{name:'ثبت سابقهٔ جدید'}).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/maintenance-history-modal.png'));
    await page.locator('.maintenance-modal .modal-foot').getByRole('button', { name: 'بستن', exact: true }).click();
    await page.getByRole('button', { name: 'سوابق نگهداری' }).click();
    await page.getByRole('heading', { name: 'سوابق سرویس و تعویض' }).waitFor();
    await page.locator('.maintenance-history-service').first().getByRole('button', { name: 'حذف' }).click();
    await page.getByRole('alertdialog', { name: 'حذف سابقه' }).waitFor();
    await page.getByRole('alertdialog').getByRole('button', { name: 'حذف', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'سابقهٔ سرویس حذف شد' }).waitFor();
    await page.locator('.maintenance-modal .modal-foot').getByRole('button', { name: 'بستن', exact: true }).click();
    await page.setViewportSize({width:390,height:844});
    await page.locator('.maint-table tbody tr').first().getByRole('button',{name:'ثبت',exact:true}).click();
    await page.getByRole('dialog',{name:/ثبت (سرویس|تعویض):/}).waitFor();
    const maintenanceModalMobile=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,document:document.documentElement.scrollWidth,width:document.querySelector('.maintenance-modal .modal')?.getBoundingClientRect().width}));
    assert(maintenanceModalMobile.document<=maintenanceModalMobile.viewport+1&&maintenanceModalMobile.width<=maintenanceModalMobile.viewport,
      `maintenance modal should fit mobile width: ${JSON.stringify(maintenanceModalMobile)}`);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:resolve(__dirname,'../../frontend/maintenance-service-modal-mobile.png')});
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({state:'detached'});
    await page.setViewportSize({width:1280,height:720});
    assert.equal((await pool.query(`SELECT count(*)::int AS total FROM ${schema}.odometer_logs`)).rows[0].total, 3);
    assert.equal((await pool.query(`SELECT count(*)::int AS total FROM ${schema}.part_logs`)).rows[0].total, 1);
    const partToEdit=await page.locator('.maint-table tbody tr').first().locator('.part-cell b').innerText();
    await page.locator('.maint-table tbody tr').first().getByRole('button',{name:`ویرایش قطعه ${partToEdit}`}).click();
    await page.getByLabel('نام قطعه',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('نام قطعه',{exact:true}).inputValue(),partToEdit);
    await page.getByRole('button',{name:'انصراف'}).click();
    await page.getByRole('button',{name:'نگهداری پیشگیرانه'}).click();
    await page.locator('.maint-pick').filter({hasText:'SMOKE-02'}).click();
    await page.locator('.sys-head').getByRole('heading',{name:'موتور'}).waitFor();
    await page.getByRole('button', { name: 'قطعات و جایگزین‌ها' }).click();
    const removablePart = page.locator('.parts-catalog article.record').filter({ hasText: 'فیلتر آزمایشی' }).first();
    page.once('dialog', dialog => dialog.accept());
    await removablePart.getByRole('button', { name: 'حذف قطعه' }).click();
    await page.getByRole('status').filter({ hasText: 'سوابق سرویس آن حفظ شده‌اند' }).waitFor();
    const deletedPartHistory = await pool.query(`SELECT part_id,part_name_snapshot FROM ${schema}.part_logs`);
    assert.deepEqual(deletedPartHistory.rows, [{ part_id: null, part_name_snapshot: 'فیلتر آزمایشی' }]);
    await page.getByRole('button',{name:'افزودن قطعه',exact:true}).click();
    await page.getByLabel('نام قطعه',{exact:true}).fill('قطعه حذف گروهی آزمایشی');
    await page.locator('select[name="system"]').selectOption('eng');
    const createBatchPartResponse=page.waitForResponse(response=>response.url().endsWith('/api/v1/parts')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'ذخیره قطعه'}).click();
    assert.equal((await createBatchPartResponse).status(),201);
    const batchPart=(await pool.query(`SELECT id,model_id FROM ${schema}.model_parts WHERE name='قطعه حذف گروهی آزمایشی'`)).rows[0];
    const batchMachine=(await pool.query(`SELECT id,unit FROM ${schema}.machines WHERE code='SMOKE-02'`)).rows[0];
    const smokeUser=(await pool.query(`SELECT id FROM ${schema}.users WHERE username='smoke-admin'`)).rows[0];
    await pool.query(`INSERT INTO ${schema}.part_logs(id,machine_id,part_id,recorded_on,reading,unit,kind,recorded_by,note) VALUES($1,$2,$3,current_date,100,$4,'service',$5,'سابقهٔ حذف گروهی')`,[randomUUID(),batchMachine.id,batchPart.id,batchMachine.unit,smokeUser.id]);
    await page.locator('.parts-model-tab').filter({hasText:'SMOKE-02'}).click();
    await page.getByRole('button',{name:'انتخاب همه'}).click();
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'حذف قطعات انتخاب‌شده'}).click();
    await page.getByRole('status').filter({hasText:'سوابق سرویس حفظ شدند'}).waitFor();
    assert.deepEqual((await pool.query(`SELECT part_id,part_name_snapshot FROM ${schema}.part_logs WHERE note='سابقهٔ حذف گروهی'`)).rows,[{part_id:null,part_name_snapshot:'قطعه حذف گروهی آزمایشی'}]);
    await page.getByRole('button', { name: 'داشبورد', exact: true }).click();
    await page.getByRole('heading', { name: 'داشبورد بررسی علائم و عملکرد خودرو' }).waitFor();
    const summary = await (await page.request.get(appUrl + '/api/v1/dashboard')).json();
    assert.equal(summary.active_machines, 1);
    assert.equal(summary.archived_repairs, 0);
    assert.equal(summary.service_records, 2);
    await page.getByRole('button', { name: 'تنظیمات و تعاریف' }).click();
    await page.getByRole('heading', { name: 'تنظیمات و تعاریف' }).waitFor();
    for(const tabName of ['عمومی','ماشین‌ها','پرسنل (راننده، سرپرست، PM)','مدل‌ها','مراحل وضعیت','قوانین اقدامات مدیریتی']) await page.getByRole('tab',{name:tabName}).waitFor();
    const generalSettingsIcon=page.getByRole('tab',{name:'عمومی'}).locator('svg');
    assert.equal(await generalSettingsIcon.evaluate(svg=>svg.querySelectorAll('line').length),9,'general settings tab must use the reference sliders icon');
    await capturePage(page, resolve(__dirname, '../../frontend/settings-desktop.png'));
    await page.getByRole('tab',{name:'مدل‌ها'}).click();
    await page.getByRole('heading',{name:'پرونده ماشین‌ها'}).waitFor();
    assert.equal(await page.locator('#machine-directory-management').evaluate(element=>element.open),true);
    await page.locator('#models-directory').waitFor({state:'visible'});
    await page.getByRole('button',{name:'تنظیمات و تعاریف'}).click();
    await page.getByRole('heading',{name:'تنظیمات و تعاریف'}).waitFor();
    const settings = await (await page.request.get(appUrl + '/api/v1/settings')).json();
    await page.getByLabel('نام شرکت').fill('سپید، ناوگان آزمایشی');
    const companySave = page.waitForResponse(response => response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT');
    await page.getByLabel('درصد هشدار موعد نگهداری').click();
    await companySave;
    await page.getByLabel('درصد هشدار موعد نگهداری').fill('20');
    const automaticSave = page.waitForResponse(response => response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT');
    await page.getByLabel('درصد هشدار موعد نگهداری').press('Tab');
    await automaticSave;
    await page.getByRole('tab',{name:'قوانین اقدامات مدیریتی'}).click();
    let autoSavedSettings = await (await page.request.get(appUrl + '/api/v1/settings')).json();
    assert.equal(autoSavedSettings.payload.companyName, 'سپید، ناوگان آزمایشی');
    assert.equal(autoSavedSettings.payload.warnPercent, 20);
    assert.equal(autoSavedSettings.revision, settings.revision + 2);
    await page.getByRole('status').waitFor({state:'detached'});
    await page.getByRole('tab',{name:'قوانین اقدامات مدیریتی'}).waitFor({state:'visible'});
    await page.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')].some(tab => tab.textContent?.includes('قوانین اقدامات مدیریتی') && tab.getAttribute('aria-selected') === 'true'));
    await capturePage(page, resolve(__dirname, '../../frontend/settings-rules-desktop.png'));
    await page.locator('[data-rule-severity="high"] input[aria-label$="اقدام مدیریتی"]').first().fill('اقدام آزمایش مرورگر');
    await page.getByRole('button', { name: 'ذخیره قوانین' }).click();
    await page.getByText('تنظیمات سامانه ذخیره شد.').waitFor();
    await page.getByRole('tab',{name:'مراحل وضعیت'}).click();
    await page.getByRole('status').waitFor({state:'detached'});
    await capturePage(page, resolve(__dirname, '../../frontend/settings-stages-desktop.png'));
    await page.getByLabel('نام مرحله').nth(0).fill('در انتظار قطعه یا خدمات');
    await page.locator('.settings-tab-panel input[type="number"]').nth(0).fill('9');
    await page.getByLabel('نوع عملیات در انتظار قطعه یا خدمات').selectOption('wait');
    await page.getByLabel('محل ماشین در انتظار قطعه یا خدمات').selectOption('part');
    await page.getByLabel('چه کسی این مرحله را ثبت می‌کند؟').nth(1).fill('مسئول قطعات آزمایشی');
    await page.getByLabel('توضیح کوتاه مرحله').nth(1).fill('پیگیری قطعه در تعمیرگاه');
    await page.getByRole('button', { name: 'ذخیره مراحل' }).click();
    await page.getByText('تنظیمات سامانه ذخیره شد.').waitFor();
    const changedSettings = await (await page.request.get(appUrl + '/api/v1/settings')).json();
    assert.equal(changedSettings.payload.warnPercent, 20);
    assert.equal(changedSettings.payload.companyName, 'سپید، ناوگان آزمایشی');
    assert.equal(changedSettings.revision, settings.revision + 4);
    assert.equal(changedSettings.payload.analysisRules.driver.high[0].action, 'اقدام آزمایش مرورگر');
    assert.equal(changedSettings.payload.stages[1].label, 'در انتظار قطعه یا خدمات');
    assert.equal(changedSettings.payload.stages[1].limit, 9);
    assert.equal(changedSettings.payload.stages[1].mode, 'wait');
    assert.equal(changedSettings.payload.stages[1].loc, 'part');
    assert.equal(changedSettings.payload.stages[1].who, 'مسئول قطعات آزمایشی');
    assert.equal(changedSettings.payload.stages[1].desc, 'پیگیری قطعه در تعمیرگاه');
    await page.getByRole('button',{name:'افزودن مرحله اینجا'}).first().click();
    await page.locator('[data-stage-id^="step_"]').waitFor();
    assert.equal(await page.locator('.settings-stage-card').first().getAttribute('data-stage-id'),'report');
    assert.equal(await page.locator('.settings-stage-card').nth(1).getAttribute('data-stage-id').then(id=>id?.startsWith('step_')),true);
    await page.getByRole('button',{name:'حذف مرحله'}).first().click();
    await page.getByRole('button',{name:'حذف مرحله'}).first().click();
    const rejectUsedStage = page.waitForResponse(response=>response.url().endsWith('/api/v1/settings')&&response.request().method()==='PUT');
    await page.getByRole('button',{name:'ذخیره مراحل'}).click();
    assert.equal((await rejectUsedStage).status(),400);
    await page.getByRole('alert').filter({hasText:'مرحله‌ای که در گردش یک پروندهٔ موجود استفاده شده باشد، قابل حذف نیست.'}).waitFor();
    assert.equal((await (await page.request.get(appUrl + '/api/v1/settings')).json()).revision,changedSettings.revision);
    await page.getByRole('tab',{name:'مراحل وضعیت'}).click();
    assert.equal((await (await page.request.get(appUrl + '/api/v1/settings/brand')).json()).companyName, 'سپید، ناوگان آزمایشی');
    await page.locator('.brand .co').getByText('سپید، ناوگان آزمایشی').waitFor();
    const legacySettings = await (await page.request.get(appUrl + '/api/v1/legacy-workspace')).json();
    assert.equal(legacySettings.payload.settings.companyName, 'سپید، ناوگان آزمایشی');
    await page.getByRole('button', { name: 'گزارش تعمیرات' }).click();
    await page.getByRole('heading', { name: 'گزارش خرابی‌ها و تعمیرات' }).waitFor();
    await page.getByRole('cell', { name: 'خرابی آزمایشی' }).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/reports-desktop.png'));
    const reportDateFrom=page.getByLabel('از تاریخ');
    await reportDateFrom.click();
    await page.getByRole('button',{name:'امروز',exact:true}).waitFor();
    await page.getByRole('button',{name:'پاک کردن',exact:true}).click();
    assert.equal(await reportDateFrom.inputValue(),'','Persian date picker should clear a filter date');
    await page.getByRole('cell', { name: 'خرابی آزمایشی' }).waitFor();
    const reportSearch=page.getByPlaceholder('مثلاً کد ماشین یا شرح خرابی');
    await reportSearch.fill('تعمیرگاه تست مرورگر');
    await page.getByRole('cell', { name: 'خرابی آزمایشی' }).waitFor();
    await reportSearch.fill('');
    const reportRows=await (await page.request.get(appUrl+'/api/v1/reports/repairs')).json();
    for(const field of ['repair_completed_date','test_completed_date','test_note','note'])assert.ok(Object.hasOwn(reportRows.find(row=>row.title==='خرابی آزمایشی'),field),`repair reports should include ${field}`);
    const reportDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'دریافت فایل CSV' }).click();
    const reportFile=await reportDownload;
    assert(reportFile.suggestedFilename().endsWith('.csv'));
    const reportCsv=await readFile(await reportFile.path(),'utf8');
    assert.match(reportCsv,/تاریخ پایان تعمیر/);
    assert.match(reportCsv,/تاریخ تست سلامت/);
    assert.match(reportCsv,/شرح تست سلامت/);
    await page.getByRole('button', { name: 'تحلیل‌های خرابی' }).click();
    await page.locator('.page-head').getByRole('heading', { name: 'تحلیل‌های خرابی' }).waitFor();
    assert.equal(await page.locator('.analysis-list-content').count(),1,'analysis list should follow the legacy page heading without an extra enclosing panel');
    assert.equal(await page.locator('.analysis-filter-grid').count(),1,'analysis list should show the reference filters even when it has no records');
    await page.getByRole('heading',{name:'هنوز تحلیلی ثبت نشده'}).waitFor();
    await page.getByRole('button',{name:'ثبت اولین تحلیل'}).waitFor();
    await page.locator('.page-head').getByRole('button', { name: 'تحلیل جدید', exact: true }).click();
    const analyses = page.locator('.page');
    await capturePage(page,resolve(__dirname,'../../frontend/analysis-wizard-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/analyses/new`);
    await page.getByLabel('موضوع خرابی').waitFor();
    await capturePage(page,resolve(__dirname,'../../frontend/analysis-wizard-legacy.png'));
    await page.goto(appUrl);
    await page.getByRole('heading',{name:'داشبورد بررسی علائم و عملکرد خودرو'}).waitFor();
    await page.getByRole('button', { name: 'تحلیل‌های خرابی' }).click();
    await page.locator('.page-head').getByRole('button', { name: 'تحلیل جدید', exact: true }).click();
    await page.getByRole('radio', { name: /SMOKE-02/ }).check();
    const linkedRepairId=(await pool.query(`SELECT id FROM ${schema}.repairs WHERE title='خرابی آزمایشی'`)).rows[0].id;
    await page.getByLabel('پروندهٔ خرابی مرتبط').selectOption(linkedRepairId);
    await analyses.getByText(/این تحلیل برای پروندهٔ خرابی خرابی آزمایشی ثبت می‌شود/).waitFor();
    await page.getByLabel('موضوع خرابی').fill('تحلیل آزمایشی');
    await page.locator('[data-analysis-step="0"]').getByLabel('علت',{exact:true}).fill('بررسی تست مرورگر');
    const analysisInfoStep=analyses.locator('[data-analysis-step="0"]');
    await analysisInfoStep.locator('input[list="analysis-driver-options"]').fill('راننده آزمایشی ویرایش');
    await analysisInfoStep.locator('select').nth(0).selectOption({label:'مسئول نگهداری آزمایشی'});
    await analysisInfoStep.locator('select').nth(1).selectOption({label:'عبدالکریم موغفاری'});
    const nextAnalysisStep = analyses.getByRole('button', { name: 'مرحلهٔ بعد' });
    await nextAnalysisStep.click();
    const driverStep = analyses.locator('[data-analysis-step="1"]');
    assert.equal(await analyses.locator('.analysis-wizard.wizard .wz-side').count(),1,'analysis wizard should use the legacy two-column step navigation');
    assert.equal(await analyses.locator('.wz-steps li').count(),7,'analysis wizard should show every legacy step');
    await analyses.locator('.wz-steps').getByRole('button',{name:'مشخصات خرابی'}).click();
    await analysisInfoStep.waitFor({state:'visible'});
    assert.equal(await analyses.locator('.wz-main .wz-head h2').innerText(),'مشخصات خرابی','step navigation should reopen the selected stage');
    await nextAnalysisStep.click();
    await driverStep.getByText('علائم قابل تشخیص بوده', { exact: true }).click();
    await driverStep.getByText('گزارش نداده است', { exact: true }).click();
    const pmStep = analyses.locator('[data-analysis-step="2"]');
    await pmStep.waitFor({state:'visible'});
    await pmStep.getByText('علائم قابل تشخیص بوده', { exact: true }).click();
    await pmStep.getByText('گزارش نداده است', { exact: true }).click();
    const pressureStep=analyses.locator('[data-analysis-step="3"]');
    await pressureStep.waitFor({state:'visible'});
    await pressureStep.getByText('فشار غیرعادی نبوده', { exact: true }).click();
    await analyses.locator('[data-analysis-step="4"]').waitFor({state:'visible'});
    await nextAnalysisStep.click();
    await analyses.locator('[data-analysis-step="5"]').waitFor({state:'visible'});
    await page.getByLabel('یادداشت تحلیل').fill('یادداشت تحلیل برای پروندهٔ ماشین');
    await analyses.locator('[data-analysis-step="5"]').locator('input[name="severity"][value="high"]').check();
    await analyses.locator('[data-analysis-step="6"]').waitFor({state:'visible'});
    const analysisReview=analyses.locator('.analysis-wizard-review');
    await analysisReview.getByText('سهل‌انگاری مشترک').waitFor();
    assert.match(await analysisReview.innerText(),/تعهد کتبی و کسر پاداش/,'final review should show the managerial action before saving');
    assert.match(await analysisReview.innerText(),/تحلیل آزمایشی/,'final review should summarize the analysis topic');
    await analyses.getByRole('button', { name: 'ثبت نهایی تحلیل' }).click();
    await page.getByRole('cell', { name: 'تحلیل آزمایشی' }).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/analyses-desktop.png'));
    const analysisSearch=analyses.getByPlaceholder('موضوع، علت، نام راننده…');
    await analysisSearch.fill('یادداشت تحلیل برای پروندهٔ ماشین');
    await page.getByRole('cell', { name: 'تحلیل آزمایشی' }).waitFor();
    assert.equal(await page.getByRole('cell', { name: 'تحلیل اصلاح‌شده' }).count(),0,'analysis list search should include free-text notes');
    await analysisSearch.fill('بررسی تست مرورگر');
    await page.getByRole('cell', { name: 'تحلیل آزمایشی' }).waitFor();
    await analysisSearch.fill('');
    await page.getByRole('button', { name: 'اقدامات مدیریتی' }).click();
    await page.getByRole('heading',{name:'اقدامات مدیریتی',exact:true}).waitFor();
    assert.equal(await page.locator('.page-head .ph-text p').innerText(),'تعداد دفعات سهل‌انگاری هر نفر به تفکیک سطح حساسیت و اقدام مدیریتی متناسب با آن');
    await page.getByRole('button',{name:'تعریف و ویرایش پرسنل'}).waitFor();
    await page.locator('.management-rules').getByText('از ابتدای ثبت سوابق (مانند فایل اکسل)').waitFor();
    const driverActionCard=page.locator('.management-person-card').filter({hasText:'راننده آزمایشی ویرایش'});
    await driverActionCard.waitFor({state:'visible'});
    assert.match(await driverActionCard.innerText(),/خیلی حساس\s*۱/,'management actions should count the new high-severity driver finding');
    await driverActionCard.click();
    await page.locator('.page-head h1').getByText('راننده آزمایشی ویرایش', {exact:true}).waitFor();
    await page.getByText('تحلیل آزمایشی', {exact:true}).waitFor();
    assert.match(await page.locator('.management-timeline').innerText(),/بار ۱/,'person history should show the cumulative occurrence number');
    await capturePage(page, resolve(__dirname, '../../frontend/actions-desktop.png'));
    await page.getByRole('button', { name: 'بازگشت به فهرست' }).click();
    await page.getByRole('button', { name: 'تحلیل‌های خرابی' }).click();
    await page.getByRole('cell', { name: 'تحلیل آزمایشی' }).waitFor();
    await page.getByRole('button', { name: 'پرونده ماشین‌ها' }).click();
    const analysisMachineCard=page.locator('.machine-card').filter({hasText:'SMOKE-02'});
    await analysisMachineCard.click();
    const analysisMachineProfile=page.getByRole('article',{name:'پروندهٔ ماشین SMOKE-02'});
    await analysisMachineProfile.getByText('سهل‌انگاری مشترک · حساسیت خیلی حساس · علت احتمالی: بررسی تست مرورگر · یادداشت تحلیل برای پروندهٔ ماشین').waitFor();
    await analysisMachineProfile.getByText('یادداشت تحلیل برای پروندهٔ ماشین').waitFor();
    await page.locator('.machine-profile-breadcrumb').click();
    await page.getByRole('button', { name: 'تحلیل‌های خرابی' }).click();
    await page.getByRole('cell', { name: 'تحلیل آزمایشی' }).waitFor();
    assert.deepEqual((await pool.query(`SELECT repair_id,responses->>'supervisor_id' AS supervisor_id FROM ${schema}.analyses WHERE topic='تحلیل آزمایشی'`)).rows,[{repair_id:linkedRepairId,supervisor_id:'p8'}]);
    assert((await page.locator('.analysis-table').innerText()).includes('اقدام آزمایش مرورگر'));
    await analyses.getByRole('button', { name: 'جزئیات', exact: true }).click();
    await analyses.getByRole('heading', { name: /تحلیل آزمایشی · SMOKE-02/ }).waitFor();
    const analysisPrintPopup = page.waitForEvent('popup');
    await analyses.getByRole('button', { name: 'چاپ فرم تحلیل' }).click();
    const analysisPrintPage = await analysisPrintPopup;
    await analysisPrintPage.getByRole('heading', { name: 'فرم بررسی علائم خرابی' }).waitFor();
    const analysisPrintText = await analysisPrintPage.locator('body').innerText();
    assert.match(analysisPrintText, /تحلیل آزمایشی/);
    assert.match(analysisPrintText, /بررسی تست مرورگر/);
    assert.match(analysisPrintText, /راننده آزمایشی ویرایش/);
    assert.match(analysisPrintText, /تست مرورگر · مدل آزمایشی ویرایش/);
    assert.match(analysisPrintText, /۱۲الف۳۴۵/);
    await analysisPrintPage.close();
    await analyses.getByRole('button',{name:'بازکردن پروندهٔ خرابی'}).click();
    await page.getByRole('article',{name:'جزئیات خرابی'}).waitFor();
    await page.getByRole('button',{name:'تحلیل‌های خرابی'}).click();
    await page.getByRole('cell',{name:'تحلیل آزمایشی'}).waitFor();
    await analyses.getByRole('button',{name:'جزئیات',exact:true}).click();
    await analyses.getByRole('button', { name: 'ویرایش تحلیل' }).click();
    await analyses.locator('[data-analysis-step="0"]').locator('input[list="analysis-driver-options"]').fill('رانندهٔ دستی آزمایشی');
    await page.getByLabel('موضوع خرابی').fill('تحلیل اصلاح‌شده');
    await nextAnalysisStep.click();
    await driverStep.getByText('علائم قابل تشخیص نبوده', { exact: true }).click();
    await nextAnalysisStep.click();
    await pmStep.getByText('علائم قابل تشخیص نبوده', { exact: true }).click();
    await nextAnalysisStep.click();
    await analyses.locator('[data-analysis-step="3"]').getByText('مثلاً اضافه‌بار یا کار خارج از توان', { exact: true }).click();
    const pressureDetails=analyses.locator('[data-analysis-step="3"]').getByLabel('توضیحات تکمیلی');
    assert.equal(await pressureDetails.evaluate(element=>element.tagName),'TEXTAREA');
    assert.equal(await pressureDetails.getAttribute('rows'),'4');
    await pressureDetails.fill('اصلاح‌شده در مرورگر');
    await nextAnalysisStep.click();
    await nextAnalysisStep.click();
    await analyses.locator('[data-analysis-step="5"]').locator('input[name="severity"][value="medium"]').check();
    await nextAnalysisStep.click();
    await analyses.locator('.analysis-wizard-review').getByText('تحلیل اصلاح‌شده').waitFor();
    await analyses.getByRole('button', { name: 'ذخیره تغییرات' }).click();
    await analyses.getByRole('heading', { name: /تحلیل اصلاح‌شده · SMOKE-02/ }).waitFor();
    assert.deepEqual((await pool.query(`SELECT responses->>'driver_id' AS driver_id,responses->>'driver_name' AS driver_name FROM ${schema}.analyses WHERE topic='تحلیل اصلاح‌شده'`)).rows,[{driver_id:null,driver_name:'رانندهٔ دستی آزمایشی'}],'free-text driver names should persist without a directory ID');
    await analysisSearch.fill('اصلاح‌شده در مرورگر');
    await page.getByRole('cell', { name: 'تحلیل اصلاح‌شده' }).waitFor();
    assert.equal(await page.getByRole('cell', { name: 'تحلیل آزمایشی' }).count(),0,'analysis list search should include edited stage questionnaire notes');
    await analysisSearch.fill('');
    const analysisDownload = page.waitForEvent('download');
    await page.locator('.page-head').getByRole('button', { name: 'خروجی اکسل (CSV)' }).click();
    assert.equal((await analysisDownload).suggestedFilename(), 'sepid-analysis-report.csv');
    await page.getByRole('button', { name: 'داشبورد' }).click();
    const dashboardCharts=page.locator('.dashboard-data-chart');
    await dashboardCharts.first().waitFor();
    assert.equal(await dashboardCharts.count(),2,'dashboard should render the reference grouped-bar and monthly trend charts');
    await dashboardCharts.nth(0).locator('.chart-xlabel').first().waitFor();
    assert.ok(await dashboardCharts.nth(0).locator('path[fill]').count()>0,'machine results should render as colored vertical bars');
    assert.equal(await dashboardCharts.nth(1).locator('circle').count(),24,'the monthly trend should plot both series across all twelve months');
    await page.getByText('فیلترها',{exact:true}).waitFor();
    const periodTab=page.getByRole('tab',{name:'۳۰ روز گذشته'});
    await periodTab.click();
    assert.equal(await periodTab.getAttribute('aria-selected'),'true','the selected dashboard period should be announced to assistive technology');
    const allPeriodTab=page.getByRole('tab',{name:'همهٔ دوره‌ها'});
    await allPeriodTab.click();
    assert.equal(await allPeriodTab.getAttribute('aria-selected'),'true');
    await page.waitForTimeout(350);
    await capturePage(page, resolve(__dirname, '../../frontend/dashboard-chart.png'));
    await page.getByRole('button', { name: 'تنظیمات و گزارش پیامک' }).click();
    await page.getByRole('heading', { name: 'پیامک', exact: true }).waitFor();
    await page.getByText('با روشن بودن ارسال خودکار، پیام هر مرحله برای گیرندگان همان مرحله در صف قرار می‌گیرد.',{exact:true}).waitFor();
    const recipientResponse=await page.request.get(appUrl+'/api/v1/sms/recipients');assert.equal(recipientResponse.status(),200);const smsRecipients=await recipientResponse.json();assert.ok(smsRecipients.some(item=>item.role==='سرپرست'&&item.name));assert.ok(smsRecipients.some(item=>item.role==='مدیر کل'&&item.name));
    const waitSmsRule=page.locator('.sms-rules-table tbody tr').filter({hasText:'در انتظار قطعه یا خدمات'});
    await waitSmsRule.getByRole('textbox',{name:'قالب پیام در انتظار قطعه یا خدمات'}).fill('گزارش «ماشین» در «مرحله» ثبت شد. [قطعه: «قطعه»]');
    await page.getByRole('button',{name:'ذخیره قوانین'}).click();
    await page.getByText('قوانین و قالب‌های پیامک برای همهٔ کاربران ذخیره شد.').waitFor();
    assert.equal((await pool.query(`SELECT payload->'smsRules'->'wait'->>'text' AS text FROM ${schema}.app_settings WHERE singleton`)).rows[0].text,'گزارش «ماشین» در «مرحله» ثبت شد. [قطعه: «قطعه»]');
    await page.getByLabel('شماره گیرنده').fill('09120000000');
    await page.getByLabel('متن پیام').fill('پیام آزمایشی بدون ارسال واقعی');
    await page.getByRole('button', { name: 'ارسال پیامک آزمایشی' }).click();
    await page.getByText('پیام آزمایشی در صف شبیه‌ساز قرار گرفت؛ پیام واقعی ارسال نمی‌شود.').waitFor();
    await page.getByText('پذیرفته‌شده توسط سرویس').first().waitFor();
    for (let i=0;i<20;i++) {
      const manual = await pool.query(`SELECT status FROM ${schema}.sms_messages WHERE message='پیام آزمایشی بدون ارسال واقعی'`);
      if (manual.rows[0]?.status === 'accepted') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.deepEqual((await pool.query(`SELECT status,provider FROM ${schema}.sms_messages WHERE message='پیام آزمایشی بدون ارسال واقعی'`)).rows, [{ status: 'accepted', provider: 'mock' }]);
    const failedSmsId=randomUUID();
    const smsAdminId=(await pool.query(`SELECT id FROM ${schema}.users WHERE username='smoke-admin'`)).rows[0].id;
    await pool.query(`INSERT INTO ${schema}.sms_messages(id,recipient,message,status,provider,response_code,attempts,created_by)
      VALUES($1,'09120000002','پیام خطای قطعی آزمایشی','failed','mock',503,1,$2)`,[failedSmsId,smsAdminId]);
    const uncertainSmsId=randomUUID();
    await pool.query(`INSERT INTO ${schema}.sms_messages(id,recipient,message,status,provider,attempts,created_by)
      VALUES($1,'09120000003','پیام با وضعیت نامشخص آزمایشی','unconfirmed','mock',1,'sms-recipient')`,[uncertainSmsId]);
    await page.getByRole('button',{name:'تازه‌سازی'}).click();
    const failedSmsRow=page.locator('tbody tr').filter({hasText:'پیام خطای قطعی آزمایشی'});
    await failedSmsRow.getByRole('button',{name:'ارسال دوباره'}).waitFor();
    const uncertainSmsRow=page.locator('tbody tr').filter({hasText:'پیام با وضعیت نامشخص آزمایشی'});
    await uncertainSmsRow.waitFor();
    assert.equal(await uncertainSmsRow.getByRole('button',{name:'ارسال دوباره'}).count(),0);
    await failedSmsRow.getByRole('button',{name:'ارسال دوباره'}).click();
    await page.getByRole('status').filter({hasText:'ارسال دوباره پیامک در صف قرار گرفت.'}).waitFor();
    for(let i=0;i<20;i++){
      const retryStatus=(await pool.query(`SELECT status FROM ${schema}.sms_messages WHERE retry_of=$1`,[failedSmsId])).rows[0]?.status;
      if(retryStatus==='accepted')break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.deepEqual((await pool.query(`SELECT status,provider,retry_of FROM ${schema}.sms_messages WHERE retry_of=$1`,[failedSmsId])).rows,[{status:'accepted',provider:'mock',retry_of:failedSmsId}]);
    await page.getByRole('button',{name:'کاربران و دسترسی‌ها'}).click();
    await page.locator('.page-head').getByRole('button',{name:'کاربر جدید'}).click();
    await page.getByLabel('نام نمایشی').fill('کاربر آزمایشی تعمیرگاه');
    await page.getByLabel('نام کاربری').fill('smoke-repair-operator');
    await page.getByLabel('رمز عبور').fill(randomBytes(18).toString('base64url'));
    await page.getByLabel('الگوی دسترسی').selectOption('supervisor');
    const permissionFields=page.locator('.fields').nth(1);
    const sectionPermission=(label)=>permissionFields.locator('label').filter({hasText:label}).locator('select');
    assert.equal(await sectionPermission('تنظیمات').inputValue(),'0');
    assert.equal(await sectionPermission('پیامک').inputValue(),'0');
    await page.getByLabel('الگوی دسترسی').selectOption('repair');
    assert.equal(await sectionPermission('تحلیل خرابی').inputValue(),'0');
    assert.equal(await sectionPermission('تنظیمات').inputValue(),'0');
    assert.equal(await page.getByLabel(/فقط پرونده‌هایی را ببیند/).isChecked(),true);
    await page.getByLabel('این کاربر کیست؟').selectOption('p8');
    await page.getByRole('button',{name:'ذخیره کاربر'}).click();
    await page.getByText('کاربر جدید ساخته شد.').waitFor();
    assert.equal((await pool.query(`SELECT scope_shop FROM ${schema}.users WHERE username='smoke-repair-operator'`)).rows[0].scope_shop,true);
    assert.equal((await pool.query(`SELECT person_id FROM ${schema}.users WHERE username='smoke-repair-operator'`)).rows[0].person_id,'p8');
    assert.equal((await pool.query(`SELECT level FROM ${schema}.user_section_permissions WHERE user_id=(SELECT id FROM ${schema}.users WHERE username='smoke-repair-operator') AND section='status'`)).rows[0].level,2);
    const peopleOnlyPassword=randomBytes(18).toString('base64url');
    await page.locator('.page-head').getByRole('button',{name:'کاربر جدید'}).click();
    await page.getByLabel('نام نمایشی').fill('کاربر فقط پرسنل');
    await page.getByLabel('نام کاربری').fill('smoke-people-reader');
    await page.getByLabel('رمز عبور').fill(peopleOnlyPassword);
    await page.getByLabel('الگوی دسترسی').selectOption('repair');
    for(const label of ['داشبورد','وضعیت ماشین‌ها','تعمیرات','ماشین‌آلات','پرسنل','نگهداری','قطعات','تنظیمات','تحلیل خرابی','پیامک'])await sectionPermission(label).selectOption('0');
    await sectionPermission('پرسنل').selectOption('1');
    await page.getByRole('button',{name:'ذخیره کاربر'}).click();
    await page.getByText('کاربر جدید ساخته شد.').waitFor();
    assert.equal((await pool.query(`SELECT level FROM ${schema}.user_section_permissions WHERE user_id=(SELECT id FROM ${schema}.users WHERE username='smoke-people-reader') AND section='people'`)).rows[0].level,1);
    assert.equal(await page.locator('.page-head .ph-actions button').count(),1,'the user heading should keep the legacy single create action');
    assert.equal(await page.locator('.users-page .report-filters').count(),0,'the legacy users view has no added search/filter bar');
    assert.deepEqual(await page.locator('.users-page table thead th').allInnerTexts(),['نام','نام کاربری','نقش','دسترسی','موبایل','وضعیت','آخرین ورود',''],'the users table columns should match the legacy list');
    assert.equal(await page.locator('.users-page .table-foot').innerText(),'۴ کاربر','the users list should show the legacy table footer with all test users');
    await page.getByText('سطح‌های دسترسی',{exact:true}).waitFor();
    await page.locator('.notice.notice-warn').getByText(/فقط/).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/users-desktop.png'));
    await page.getByRole('button',{name:'خرابی‌های در جریان'}).click();
    await page.locator('.top-actions').getByRole('button',{name:'اعلام خرابی',exact:true}).click();
    await page.getByText(/بعد از ثبت، ماشین در مرحلهٔ/).waitFor();
    await page.locator('.machine-pick').getByRole('button', { name: 'SMOKE-02' }).click();
    await page.getByLabel('نوع خرابی').fill('خرابی با تست رد شده');
    await page.getByRole('button',{name:'ثبت خرابی',exact:true}).click();
    await page.getByRole('heading',{name:'تاریخچهٔ مراحل'}).waitFor();
    const rejectedDetail=page.getByRole('article',{name:'جزئیات خرابی'});
    const rejectedNext=rejectedDetail.getByRole('button',{name:'ثبت مرحلهٔ بعد'});
    await rejectedNext.click();await rejectedDetail.getByText(/SMOKE-02 · در انتظار قطعه یا خدمات/).waitFor();
    await rejectedNext.click();await rejectedDetail.getByRole('heading',{name:'تست سلامت'}).waitFor();
    await rejectedDetail.getByLabel('نتیجهٔ تست').selectOption('fail');
    await rejectedNext.click();
    await rejectedDetail.getByRole('button',{name:'اعلام خرابی جدید برای همین ماشین'}).waitFor();
    const rejected=(await pool.query(`SELECT id,number FROM ${schema}.repairs WHERE title='خرابی با تست رد شده'`)).rows[0];
    await rejectedDetail.getByRole('button',{name:'اعلام خرابی جدید برای همین ماشین'}).click();
    await page.getByText(/تست سلامت پروندهٔ .* رد شده است.*تاریخچهٔ ماشین/).waitFor();
    await page.getByLabel('نوع خرابی').fill('تکرار خرابی پس از تست');
    await page.getByRole('button',{name:'ثبت خرابی',exact:true}).click();
    await page.getByRole('heading',{name:'تاریخچهٔ مراحل'}).waitFor();
    assert.deepEqual((await pool.query(`SELECT previous_repair_id,title FROM ${schema}.repairs WHERE previous_repair_id=$1`,[rejected.id])).rows,
      [{previous_repair_id:rejected.id,title:'تکرار خرابی پس از تست'}]);
    await page.getByRole('button', { name: 'گزارش تعمیرات' }).click();
    await page.getByLabel('وضعیت پرونده').selectOption('closed');
    await page.getByRole('cell', { name: 'خرابی با تست رد شده' }).waitFor();
    await page.getByLabel('وضعیت پرونده').selectOption('open');
    assert.equal(await page.getByRole('cell', { name: 'خرابی با تست رد شده' }).count(),0);
    const oldArchiveId=randomUUID();
    const archiveMachineId=(await pool.query(`SELECT machine_id FROM ${schema}.repairs WHERE title='خرابی با تست رد شده'`)).rows[0].machine_id;
    await pool.query(`INSERT INTO ${schema}.repairs(id,machine_id,title,urgency,stage,result,report_date,return_date)
      VALUES($1,$2,'پرونده قدیمی قبل از تست','urgent','test','old','2026-11-11','2026-11-12')`,[oldArchiveId,archiveMachineId]);
    await page.getByRole('button',{name:'بایگانی تعمیرات',exact:true}).click();
    await page.getByRole('heading',{name:'بایگانی تعمیرات'}).waitFor();
    await page.getByText('پرونده خرابی‌هایی که تست سلامتشان در کارخانه ثبت شده است؛ هیچ پرونده‌ای پاک نمی‌شود').waitFor();
    await page.getByLabel('از تاریخ تست').waitFor();
    assert.equal(await page.getByLabel('وضعیت پرونده').count(),0,'the archive should use its own filters instead of the general report filter set');
    await page.getByRole('button',{name:'تست سلامت رد'}).click();
    await page.getByRole('cell',{name:'خرابی با تست رد شده'}).waitFor();
    await page.getByRole('button',{name:/قبل از راه‌اندازی تست/}).click();
    await page.getByRole('cell',{name:'پرونده قدیمی قبل از تست'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'خروجی اکسل'}).isEnabled(),true,'the archive export should enable when matching rows exist');
    await capturePage(page, resolve(__dirname, '../../frontend/archive-page-desktop.png'));
    await page.getByRole('button',{name:'گزارش تعمیرات'}).click();
    await page.getByRole('link', { name: 'محیط سازگار با نسخهٔ قبلی' }).click();
    await page.locator('#themeBtn').waitFor();
    const savedWorkspace = page.waitForResponse(response =>
      response.url().endsWith('/api/v1/legacy-workspace') && response.request().method() === 'PUT');
    await page.locator('#themeBtn').click();
    assert.equal((await savedWorkspace).status(), 200);
    const snapshot = (await pool.query(`SELECT revision, payload FROM ${schema}.legacy_workspace`)).rows[0];
    assert(snapshot.revision >= 1, 'Legacy workspace changes must persist with a positive revision');
    assert.equal(snapshot.payload.schema, 4);
    assert(!('users' in snapshot.payload));
    await page.goto(`${appUrl}/legacy-online.html#/dashboard`);
    await page.locator('#menuBtn').waitFor();
    await page.getByRole('heading', { name: 'داشبورد بررسی علائم و عملکرد خودرو' }).waitFor();
    await page.waitForTimeout(350);
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-dashboard-desktop.png'));
    await page.setViewportSize({ width: 390, height: 844 });
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-dashboard-mobile.png'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${appUrl}/legacy-online.html#/settings`);
    await page.locator('#gen select[name="theme"]').selectOption('light');
    await page.locator('html[data-theme="light"]').waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-settings-light-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/status`);
    await page.getByRole('heading', { name: 'وضعیت ماشین‌ها' }).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-status-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/machines`);
    await page.getByRole('heading', { name: 'پرونده ماشین‌ها' }).waitFor();
    await page.locator('.machine-card').first().waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-machines-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/repairs`);
    await page.getByRole('heading', { name: 'خرابی‌های در جریان' }).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-repairs-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/maint`);
    await page.getByRole('heading', { name: 'نگهداری پیشگیرانه' }).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-maintenance-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/parts`);
    await page.getByRole('heading', { name: 'قطعات جایگزین' }).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-parts-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/settings/rules`);
    await page.locator('.rules-editor').waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-settings-rules-light-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/settings/stages`);
    await page.locator('#stageCfg').waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-settings-stages-light-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/archive`);
    await page.getByRole('heading',{name:'بایگانی تعمیرات'}).waitFor();
    await page.getByRole('heading',{name:'بایگانی هنوز خالی است'}).waitFor();
    await capturePage(page, resolve(__dirname, '../../frontend/legacy-archive-empty-desktop.png'));
    await page.goto(`${appUrl}/legacy-online.html#/dashboard`);
    await page.locator('#menuBtn').waitFor();
    await page.getByRole('link', { name: 'پشتیبان‌گیری' }).click();
    await page.getByRole('heading', { name: /پشتیبان‌گیری و بازیابی/ }).waitFor();
    const importedWorkspace = {
      ...snapshot.payload,
      settings: { ...snapshot.payload.settings, companyName: 'شرکت آزمایشی بازیابی', warnPercent: 12, countWindow: 'year', backupRemindDays: 9 },
    };
    await page.locator('#restoreFile').setInputFiles({
      name: 'fleet-backup.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ app: 'fleet-maint', version: 1, data: importedWorkspace })),
    });
    await page.getByRole('button', { name: 'بازیابی شود' }).click();
    await page.getByText('اطلاعات با موفقیت بازیابی شد').waitFor();
    const importedState = (await pool.query(`SELECT payload FROM ${schema}.legacy_workspace`)).rows[0].payload;
    assert.equal(importedState.settings.companyName, 'شرکت آزمایشی بازیابی');
    const importedSettings = (await pool.query(`SELECT payload FROM ${schema}.app_settings`)).rows[0].payload;
    assert.equal(importedSettings.countWindow, 'year');
    assert.equal(importedSettings.backupRemindDays, 9);
    const stale = await page.request.put(appUrl + '/api/v1/legacy-workspace', {
      headers: { 'X-Sepid-Request': '1' }, data: { revision: 0, payload: snapshot.payload },
    });
    assert.equal(stale.status(), 409);
    await page.reload();
    await page.locator('#themeBtn').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), snapshot.payload.settings.theme);
    await page.goto(appUrl);
    await page.getByRole('heading', { name: 'داشبورد بررسی علائم و عملکرد خودرو' }).waitFor();
    await page.locator('.rep-board .sum-tile.crit').getByText('دارای تأخیر').waitFor();
    await page.getByRole('heading', { name: 'جزئیات آخرین بررسی‌ها' }).waitFor();
    await page.getByRole('heading', { name: 'توزیع نتایج بررسی‌ها' }).waitFor();
    await page.getByRole('heading', { name: 'مقایسه نتایج بر اساس ماشین' }).waitFor();
    await page.getByText('تعداد کل بررسی‌ها', { exact: true }).waitFor();
    const analysisColumnWidths = await page.locator('.dashboard-analysis-grid > .card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().width));
    assert(analysisColumnWidths[0] / analysisColumnWidths[1] > 1.65 && analysisColumnWidths[0] / analysisColumnWidths[1] < 1.85,
      'dashboard latest-analysis column should be 1.75 times the fleet-risk column, matching the legacy dashboard');
    assert.equal(await page.locator('.fleet-badge .ic').count(), 1, 'the fleet risk status should show its matching legacy icon');
    await page.getByText('نرخ سهل‌انگاری', { exact: true }).waitFor();
    const trendLabelBounds = await page.locator('.dashboard-empty-trend .chart-xlabel').evaluateAll(labels => labels.map(label => {
      const { top, bottom } = label.getBoundingClientRect();
      return { top, bottom };
    }));
    const trendChartBounds = await page.locator('.dashboard-empty-trend').evaluate(chart => {
      const { top, bottom } = chart.getBoundingClientRect();
      return { top, bottom };
    });
    assert(trendLabelBounds.length === 12 && trendLabelBounds.every(label => label.top >= trendChartBounds.top && label.bottom <= trendChartBounds.bottom + 1),
      'all twelve Persian month labels should remain visible inside the legacy-height trend chart');
    assert.deepEqual(await page.locator('.dashboard-analysis-grid .card-head h3').evaluateAll(elements=>elements.map(element=>element.innerText.trim())),['جزئیات آخرین بررسی‌ها','وضعیت کلی ناوگان'],'dashboard analysis cards should follow the legacy right-to-left order');
    assert.equal(await page.locator('.dashboard-bottom-grid .dashboard-actions-card').count(), 1,
      'maintenance and current management actions should share the legacy dashboard row');
    assert.equal(await page.getByRole('heading', { name: 'خرابی‌های ثبت‌شده در هفت روز اخیر' }).count(), 0,
      'weekly chart is not part of the legacy dashboard');
    assert.equal(await page.locator('.dashboard-stage-card').count(), 0,
      'extra stage-count card is not part of the legacy dashboard');
    await page.getByLabel('فیلتر ماشین داشبورد').selectOption({ label: 'SMOKE-02' });
    assert.equal((await page.locator('.kpi-total .kpi-value').innerText()).trim(), '۱');
    await page.getByLabel('فیلتر ماشین داشبورد').selectOption('');
    await page.waitForTimeout(350);
    await capturePage(page, resolve(__dirname, '../../frontend/dashboard-desktop.png'));
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileDashboardHeading = await page.locator('.dashboard-heading h2').evaluate(element => ({
      fontSize: getComputedStyle(element).fontSize,
      height: element.getBoundingClientRect().height,
    }));
    assert.equal(mobileDashboardHeading.fontSize, '20px', 'the mobile dashboard heading should use the legacy size');
    assert(mobileDashboardHeading.height <= 30, 'the dashboard heading should fit on one line at 390px');
    await capturePage(page, resolve(__dirname, '../../frontend/dashboard-mobile.png'));
    await page.getByRole('button', { name: 'منو', exact: true }).click();
    await page.getByRole('button', { name: 'پرونده ماشین‌ها' }).click();
    await page.getByRole('heading', { name: 'پرونده ماشین‌ها' }).waitFor();
    await page.locator('.machine-card').first().waitFor();
    assert.equal(await page.locator('[aria-label="جست‌وجو و فیلتر ماشین‌ها"]').count(),0,
      'the fleet page should keep the legacy direct-to-cards layout without an extra filter panel');
    const machinePageGeometry=await page.evaluate(()=>{
      const heading=document.querySelector('.page-head')?.getBoundingClientRect();
      const grid=document.querySelector('.machine-grid')?.getBoundingClientRect();
      return {headingBottom:heading?.bottom,gridTop:grid?.top};
    });
    assert(machinePageGeometry.headingBottom!==undefined&&machinePageGeometry.gridTop!==undefined&&machinePageGeometry.gridTop-machinePageGeometry.headingBottom<=30,
      `the machine cards should begin directly beneath the legacy page heading: ${JSON.stringify(machinePageGeometry)}`);
    await page.waitForFunction(() => !document.body.classList.contains('nav-open'));
    await page.getByRole('button', { name: 'تغییر پوسته' }).click();
    await capturePage(page, resolve(__dirname, '../../frontend/machines-mobile.png'));
    const mobileSections = [
      'وضعیت ماشین‌ها','خرابی‌های در جریان','بایگانی تعمیرات','گزارش تعمیرات',
      'نگهداری پیشگیرانه','قطعات و جایگزین‌ها','تحلیل‌های خرابی','اقدامات مدیریتی',
      'تنظیمات و تعاریف','کاربران و دسترسی‌ها',
    ];
    for (const section of mobileSections) {
      await page.getByRole('button', { name: 'منو', exact: true }).click();
      await page.getByRole('button', { name: section, exact: true }).click();
      await page.waitForFunction(() => !document.body.classList.contains('nav-open'));
      await page.waitForTimeout(120);
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
      }));
      assert(dimensions.document <= dimensions.viewport + 1,
        `the ${section} page must not introduce horizontal overflow at mobile width: ${JSON.stringify(dimensions)}`);
    }
    await page.getByRole('button', { name: 'منو', exact: true }).click();
    await page.getByRole('button', { name: 'تحلیل‌های خرابی', exact: true }).click();
    await page.waitForFunction(() => !document.body.classList.contains('nav-open'));
    await page.locator('.page-head').getByRole('button',{name:'تحلیل جدید',exact:true}).click();
    await page.locator('.analysis-wizard .wz-steps').waitFor();
    await capturePage(page,resolve(__dirname,'../../frontend/analysis-wizard-mobile.png'));
    const wizardMobileGeometry=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,document:document.documentElement.scrollWidth,steps:document.querySelector('.wz-steps')?.getBoundingClientRect().width}));
    assert(wizardMobileGeometry.document<=wizardMobileGeometry.viewport+1,`analysis wizard should fit mobile width: ${JSON.stringify(wizardMobileGeometry)}`);
    assert((wizardMobileGeometry.steps??0)>0,'analysis step navigation should remain visible on mobile');
    await page.locator('.page-head').getByRole('button',{name:'بازگشت به تحلیل‌ها'}).click();
    await page.getByRole('button', { name: 'منو', exact: true }).click();
    await page.getByRole('button', { name: 'خروج', exact: true }).click();
    await page.getByRole('button', { name: 'ورود', exact: true }).waitFor();
    await page.getByLabel('نام کاربری').fill('smoke-people-reader');
    await page.getByLabel('رمز عبور').fill(peopleOnlyPassword);
    await page.getByRole('button', { name: 'ورود', exact: true }).click();
    await page.getByRole('button', { name: 'منو', exact: true }).click();
    await page.getByRole('button', { name: 'اقدامات مدیریتی', exact: true }).click();
    await page.getByRole('heading', { name: 'اقدامات مدیریتی' }).waitFor();
    await page.getByText(/برای دیدن شمارش سهل‌انگاری و اقدام‌های جاری، مجوز مشاهدهٔ تحلیل‌ها لازم است/).waitFor();
    assert.equal(await page.locator('.management-severity-grid').count(),0,'people-only readers must not see invented zero-count analysis summaries');
    assert.equal((await page.request.get(appUrl + '/api/v1/analyses')).status(),403,'people-only readers must not have analysis API access');
    await page.getByRole('button', { name: 'منو', exact: true }).click();
    await page.getByRole('button', { name: 'پرسنل', exact: true }).waitFor();
    await page.getByRole('button', { name: 'پرسنل', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'پرونده ماشین‌ها', exact: true }).count(),0,'people-only users must not need machine permission');
    await page.getByRole('button', { name: 'منو', exact: true }).click();
    await page.getByRole('button', { name: 'پرسنل', exact: true }).click();
    await page.getByRole('heading', { name: 'تنظیمات و تعاریف', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'تعریف فرد جدید' }).count(),0,'read-only users must not see person creation');
    assert.equal(await page.getByRole('columnheader', { name: 'تلفن' }).count(),0,'read-only users must not receive phone details');
    assert(await page.getByRole('heading',{name:'رانندگان'}).count()>0,'the people directory should group drivers like the reference');
    assert(await page.getByRole('columnheader',{name:'ماشین‌ها'}).count()>0,'people should show vehicle assignments');
    assert(await page.getByText('SMOKE-02',{exact:true}).count()>0,'read-only people access should retain assigned vehicle codes');
    assert.equal(await page.request.get(appUrl + '/api/v1/people').then(response=>response.status()),200);
    assert.equal(await page.request.get(appUrl + '/api/v1/machines').then(response=>response.status()),403);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: 'خروج' }).click();
    await page.getByRole('button', { name: 'ورود', exact: true }).waitFor();
    const finalBrand=await (await page.request.get(appUrl + '/api/v1/settings/brand')).json();
    assert.equal(await page.locator('.auth-brand .co').innerText(),finalBrand.companyName);
    assert.equal(await page.locator('.auth-side small').innerText(),finalBrand.orgName);
    assert.equal((await page.request.get(appUrl + '/api/v1/machines')).status(), 401);
    await pool.query(`TRUNCATE TABLE ${schema}.users CASCADE`);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload();
    await page.getByRole('heading', { name: 'راه‌اندازی اولیه' }).waitFor();
    const firstPassword = randomBytes(18).toString('base64url');
    await page.screenshot({ path: resolve(__dirname, '../../frontend/setup-desktop.png') });
    await page.getByLabel('نام کاربری مدیر کل').fill('bootstrap-admin');
    await page.getByLabel('رمز عبور', { exact: true }).fill(firstPassword);
    await page.getByLabel('تکرار رمز عبور').fill(firstPassword);
    await page.getByRole('button', { name: 'ذخیره و ورود' }).click();
    await page.getByRole('heading', { name: 'داشبورد بررسی علائم و عملکرد خودرو' }).waitFor();
    assert.equal((await page.request.get(appUrl + '/api/v1/users')).status(), 200);
    await page.getByRole('button', { name: 'خروج', exact: true }).click();
    await page.getByRole('heading', { name: 'ورود به سامانه' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'راه‌اندازی اولیه' }).count(), 0, 'logging out after bootstrap must show login, not the first-admin setup form');
    await page.getByLabel('نام کاربری').fill('bootstrap-admin');
    await page.getByLabel('رمز عبور', { exact: true }).fill(firstPassword);
    await page.getByRole('button', { name: 'ورود', exact: true }).click();
    await page.getByRole('heading', { name: 'داشبورد بررسی علائم و عملکرد خودرو' }).waitFor();
    assert.deepEqual(pageErrors,[],`browser pages must not produce unhandled JavaScript errors: ${JSON.stringify(pageErrors)}`);
    console.log('Browser smoke passed: public OpenAPI contract, five-attempt login lockout and recovery, first-admin setup then logout/login, self-service password change, dashboard empty-analysis call to action and legacy section ordering, sidebar repair-count badge, four-result comparison, guide, migration preview, healthy-fleet shortcut to the matching machine profile, directory create/edit and safe unused-model deletion, management-action severity aggregation and person history, role presets, status view, repair flow, repeat-stage updates, reversible stage history, rejected-test follow-up, archive including pre-test legacy result, machine-history category filters and print, parts search/system/alternative filters and CSV, part create/edit/delete, maintenance initial service/CSV/history deletion, used-stage removal rejection, analysis create/edit and manual driver name persistence, reports, SMS mock, safe retry visibility and queue, backup, persistence, mobile navigation and overflow checks across ten core pages plus analysis wizard mobile width, logout.');
  } finally {
    try {
      await browser?.close();
    } finally {
      for (const child of children.reverse()) child.kill();
      try {
        if (schemaCreated) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
