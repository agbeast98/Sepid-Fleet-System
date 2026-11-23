const { strict: assert } = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { resolve } = require('node:path');
const { createServer } = require('node:net');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { Pool } = require('pg');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const schema = `sepid_api_smoke_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(20).toString('hex');
  const username = `smoke_${randomBytes(5).toString('hex')}`;
  const port = await freePort();
  const backupDirectory = await mkdtemp(resolve(tmpdir(), 'sepid-backup-smoke-'));
  const backupName = 'sepid-20261112T120000Z.dump';
  const backupContent = Buffer.from('isolated backup download fixture');
  await writeFile(resolve(backupDirectory, backupName), backupContent);
  const base = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 4000 });
  let child;
  let childOutput = '';
  let created = false;
  try {
    await base.query(`CREATE SCHEMA ${schema}`);
    created = true;
    const isolated = new URL(process.env.DATABASE_URL);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    // Exercise the exact migration entry point used by development and Docker
    // instead of applying SQL files directly in the smoke test.
    execFileSync(process.execPath, [resolve(__dirname, 'migrate.cjs')], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: isolated.href },
      stdio: 'pipe',
    });
    const db = new Pool({ connectionString: isolated.href });
    try {
      assert.equal((await db.query('SELECT count(*)::int AS count FROM machines')).rows[0].count, 11);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM machines WHERE floating_driver')).rows[0].count, 5,
        'starter loaders and tractors should retain their variable-driver setting');
      const invalidFloatingAssignment = await db.query("UPDATE machines SET driver_id='p1' WHERE id='m7'").then(() => null, error => error.code);
      assert.equal(invalidFloatingAssignment, '23514', 'a floating-driver machine must not keep a fixed driver assignment');
      assert.equal((await db.query('SELECT count(*)::int AS count FROM legacy_workspace')).rows[0].count, 0);
    } finally { await db.end(); }

    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['dist/main.js'], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'development', SMS_WORKER_DISABLED: 'true', HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: isolated.href,
        SMS_PROVIDER: 'mock', BACKUP_DIRECTORY: backupDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { childOutput = (childOutput + chunk.toString()).slice(-12000); });
    child.stderr.on('data', chunk => { childOutput = (childOutput + chunk.toString()).slice(-12000); });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error('API exited before readiness');
      const response = await fetch(origin + '/api/v1/health/ready', { signal: AbortSignal.timeout(500) }).catch(() => null);
      if (response?.ok) break;
      if (attempt === 59) throw new Error('API did not become ready');
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    const publicBrand = await fetch(origin + '/api/v1/settings/brand');
    assert.equal(publicBrand.status, 200, 'login brand must be available before authentication');
    assert.equal((await publicBrand.json()).companyName, 'شرکت دام و طیور سپید بستک');

    const setupStatus = await (await fetch(origin + '/api/v1/auth/setup-status')).json();
    assert.equal(setupStatus.required, true, 'fresh deployment should offer the initial admin setup');
    const firstAdminSetup = await fetch(origin + '/api/v1/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sepid-Request': '1' },
      body: JSON.stringify({ username, password, confirmPassword: password }) });
    assert.equal(firstAdminSetup.status, 201, await firstAdminSetup.clone().text());
    assert(firstAdminSetup.headers.get('set-cookie')?.includes('HttpOnly'));
    assert.deepEqual(await (await fetch(origin + '/api/v1/auth/setup-status')).json(), { required: false });
    const secondSetup = await fetch(origin + '/api/v1/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sepid-Request': '1' },
      body: JSON.stringify({ username: `${username}_second`, password, confirmPassword: password }) });
    assert.equal(secondSetup.status, 409, 'subsequent admin setup must be closed');
    for (let attempt = 1; attempt <= 4; attempt++) {
      const failed = await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sepid-Request': '1' },
        body: JSON.stringify({ username, password: `${password}_wrong` }) });
      assert.equal(failed.status, 401, `failed login ${attempt} should not lock the account yet`);
    }
    const lockout = await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sepid-Request': '1' },
      body: JSON.stringify({ username, password: `${password}_wrong` }) });
    assert.equal(lockout.status, 403);
    assert.match(await lockout.text(), /۱۵ دقیقه/);
    const lockedCorrect = await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sepid-Request': '1' },
      body: JSON.stringify({ username, password }) });
    assert.equal(lockedCorrect.status, 403, 'correct password must not bypass an active account lockout');
    await base.query(`UPDATE ${schema}.users SET failed_login_attempts=0,login_locked_until=NULL WHERE lower(username)=lower($1)`, [username]);
    const login = await fetch(origin + '/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sepid-Request': '1' },
      body: JSON.stringify({ username, password, remember: true }),
    });
    assert.equal(login.status, 201);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert(cookie?.startsWith('sepid_session='));
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Sepid-Request': '1' };
    const secondSessionLogin = await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sepid-Request': '1' },
      body: JSON.stringify({ username, password }) });
    assert.equal(secondSessionLogin.status, 201, 'a second browser session should be allowed before rotation');
    const secondSessionCookie = secondSessionLogin.headers.get('set-cookie')?.split(';', 1)[0];
    const rotatedPassword = randomBytes(20).toString('hex');
    const invalidCurrentPassword = await fetch(origin + '/api/v1/auth/password', { method: 'POST', headers, body: JSON.stringify({ currentPassword: `${password}_wrong`, password: rotatedPassword, confirmPassword: rotatedPassword }) });
    assert.equal(invalidCurrentPassword.status, 401, 'changing a password must verify the current password');
    const passwordChange = await fetch(origin + '/api/v1/auth/password', { method: 'POST', headers, body: JSON.stringify({ currentPassword: password, password: rotatedPassword, confirmPassword: rotatedPassword }) });
    assert.equal(passwordChange.status, 201, await passwordChange.clone().text());
    assert.equal((await fetch(origin + '/api/v1/auth/me', { headers: { Cookie: cookie } })).status, 200, 'the changing browser session should stay active');
    assert.equal((await fetch(origin + '/api/v1/auth/me', { headers: { Cookie: secondSessionCookie } })).status, 401, 'other browser sessions should be revoked after password rotation');
    const oldPasswordLogin = await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sepid-Request': '1' },
      body: JSON.stringify({ username, password }) });
    assert.equal(oldPasswordLogin.status, 401, 'the previous password must stop working after rotation');
    const rotatedPasswordLogin = await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sepid-Request': '1' },
      body: JSON.stringify({ username, password: rotatedPassword }) });
    assert.equal(rotatedPasswordLogin.status, 201, 'the replacement password should work');
    const orderedFleet = await (await fetch(origin + '/api/v1/machines', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(orderedFleet.map(machine=>machine.code),[
      'FM 414','FM 122','BENZ 655','BENZ 173','ISUZU 598','ISUZU 776','ZL30','VOLVO L90','MF285 زرد','MF285 قرمز','MF475 قرمز',
    ],'the starter fleet should retain the legacy display order');
    const initialStages = await (await fetch(origin + '/api/v1/repairs/stages', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(initialStages.map(stage => stage.id), ['report','dispatch','wait','done','test']);
    assert.equal(initialStages[0].label,'اعلام خرابی');
    assert.equal(initialStages[0].desc,'خرابی ثبت شده و ماشین هنوز در کارخانه است');
    assert.equal(initialStages[4].label,'تست سلامت (ماشین در کارخانه)');
    const request = (path, method, body) => fetch(origin + '/api/v1' + path, { headers, method, body: JSON.stringify(body) });
    const dispatchFixtureResponse = await request('/repairs', 'POST', { machine_id:'m1', title:'آزمون اعزام', urgency:'none', report_date:'2026-11-12' });
    assert.equal(dispatchFixtureResponse.status, 201, await dispatchFixtureResponse.clone().text());
    const dispatchFixture = await dispatchFixtureResponse.json();
    const dispatchPath = '/repairs/' + dispatchFixture.id;
    const fromReport = { previous:'report', version:dispatchFixture.version };
    assert.equal((await request(dispatchPath+'/events','POST',{...fromReport,shop:'تعمیرکار آزمایشی'})).status,400);
    assert.equal((await request(dispatchPath+'/events','POST',{...fromReport,refer_date:'2026-11-13',shop:'  '})).status,400);
    const dispatched = await request(dispatchPath+'/events','POST',{...fromReport,refer_date:'2026-11-13',shop:'تعمیرکار آزمایشی'});
    assert.equal(dispatched.status,201,await dispatched.clone().text());
    const dispatchRecord = await dispatched.json();
    assert.equal(dispatchRecord.stage,'dispatch');
    assert.equal(dispatchRecord.refer_date,'2026-11-13');
    assert.equal(dispatchRecord.shop,'تعمیرکار آزمایشی');
    const fromDispatch = {previous:'dispatch',version:dispatchRecord.version};
    assert.equal((await request(dispatchPath+'/events','POST',fromDispatch)).status,400);
    assert.equal((await request(dispatchPath+'/events','POST',{...fromDispatch,expected_date:'2026-11-12'})).status,400);
    const waiting = await request(dispatchPath+'/events','POST',{...fromDispatch,expected_date:'2026-11-20'});
    assert.equal(waiting.status,201,await waiting.clone().text());
    const waitingRecord = await waiting.json();
    assert.equal(waitingRecord.stage,'wait');
    assert.equal(waitingRecord.expected_date,'2026-11-20');
    const completed = await request(dispatchPath+'/events','POST',{previous:'wait',version:waitingRecord.version});
    assert.equal(completed.status,201,await completed.clone().text());
    const completedRecord = await completed.json();
    assert.equal(completedRecord.stage,'done');
    const passed = await request(dispatchPath+'/events','POST',{previous:'done',version:completedRecord.version,result:'pass'});
    assert.equal(passed.status,201,await passed.clone().text());
    const passedRecord = await passed.json();
    const statusAfterPass = await (await request('/status','GET')).json();
    assert.equal(statusAfterPass.machines.find(machine=>machine.id==='m1').last_repair_result,'pass');
    assert(!statusAfterPass.repairs.some(item=>item.id===dispatchFixture.id));
    const linked = await request('/analyses','POST',{machine_id:'m1',repair_id:dispatchFixture.id,date:'2026-11-13',topic:'آزمون حذف تحلیل مرتبط',severity:'low',cause:'',note:''});
    assert.equal(linked.status,201,await linked.clone().text());
    const linkedAnalysis = await linked.json();
    assert.equal((await request(dispatchPath,'DELETE',{version:dispatchFixture.version})).status,409);
    assert.equal((await request(dispatchPath,'DELETE',{version:passedRecord.version})).status,200);
    const preservedAnalysis = (await (await request('/analyses','GET')).json()).find(item=>item.id===linkedAnalysis.id);
    assert.equal(preservedAnalysis.repair_id,null);
    assert.equal((await request('/analyses/'+linkedAnalysis.id,'DELETE')).status,200);
    assert.equal((await request('/analyses/'+linkedAnalysis.id,'DELETE')).status,404);
    const diagnoserOptions = await (await fetch(origin + '/api/v1/repairs/diagnosers', { headers: { Cookie: cookie } })).json();
    assert(diagnoserOptions.includes('عبدالکریم موغفاری') && diagnoserOptions.includes('علی شبانی'),
      'repair diagnoser suggestions should include active supervisors and PM personnel from the shared directory');

    const failedSmsId = randomUUID();
    const uncertainSmsId = randomUUID();
    const smsAdminId = (await base.query(`SELECT id FROM ${schema}.users WHERE username=$1`,[username])).rows[0].id;
    await base.query(`INSERT INTO ${schema}.sms_messages(id,recipient,message,status,provider,response_code,attempts,created_by)
      VALUES($1,'09120000002','پیام با خطای قطعی','failed','mock',503,1,$2),($3,'09120000003','پیام با وضعیت نامشخص','unconfirmed', 'mock',NULL,1,$2)`,
      [failedSmsId,smsAdminId,uncertainSmsId]);
    const smsRetry = await fetch(origin + `/api/v1/sms/${failedSmsId}/retry`, {method:'POST',headers,body:JSON.stringify({})});
    assert.equal(smsRetry.status,201,await smsRetry.clone().text());
    const queuedRetry = await smsRetry.json();
    assert.equal(queuedRetry.retry_of,failedSmsId);
    const uncertainRetry = await fetch(origin + `/api/v1/sms/${uncertainSmsId}/retry`, {method:'POST',headers,body:JSON.stringify({})});
    assert.equal(uncertainRetry.status,400,'uncertain messages must not be re-sent');
    assert.equal((await base.query(`SELECT count(*)::int AS total FROM ${schema}.sms_messages WHERE retry_of=$1`,[failedSmsId])).rows[0].total,1);
    await base.query(`UPDATE ${schema}.sms_messages SET status='failed',attempts=1 WHERE id=$1`,[queuedRetry.id]);
    const secondSmsRetry = await fetch(origin + `/api/v1/sms/${queuedRetry.id}/retry`, {method:'POST',headers,body:JSON.stringify({})});
    assert.equal(secondSmsRetry.status,201,await secondSmsRetry.clone().text());
    const queuedSecondSmsRetry = await secondSmsRetry.json();
    await base.query(`UPDATE ${schema}.sms_messages SET status='failed',attempts=1 WHERE id=$1`,[queuedSecondSmsRetry.id]);
    const cappedSmsRetry = await fetch(origin + `/api/v1/sms/${queuedSecondSmsRetry.id}/retry`, {method:'POST',headers,body:JSON.stringify({})});
    assert.equal(cappedSmsRetry.status,403,'retry chains must stop after two manual retries');

    const backupListResponse = await fetch(origin + '/api/v1/backups', { headers: { Cookie: cookie } });
    assert.equal(backupListResponse.status, 200);
    const listedBackups = await backupListResponse.json();
    assert.deepEqual(listedBackups.map(item => item.name), [backupName]);
    assert.equal(listedBackups[0].size, backupContent.length);
    const backupDownload = await fetch(origin + `/api/v1/backups/${backupName}`, { headers: { Cookie: cookie } });
    assert.equal(backupDownload.status, 200);
    assert.equal(backupDownload.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await backupDownload.arrayBuffer()), backupContent);
    assert.equal((await fetch(origin + '/api/v1/backups/%2e%2e', { headers: { Cookie: cookie } })).status, 404);
    const restrictedPassword = randomBytes(16).toString('hex');
    const availableStages = await (await fetch(origin + '/api/v1/repairs/stages', { headers: { Cookie: cookie } })).json();
    const restrictedAccount = await fetch(origin + '/api/v1/users', { method: 'POST', headers,
      body: JSON.stringify({ username: `restricted_${username}`, name: 'کاربر محدود آزمایشی', active: true, password: restrictedPassword, permissions: { dashboard: 1, machines: 1 }, stages: availableStages.map(stage => stage.id) }) });
    assert.equal(restrictedAccount.status, 201, await restrictedAccount.clone().text());
    const restrictedLogin = await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sepid-Request': '1' },
      body: JSON.stringify({ username: `restricted_${username}`, password: restrictedPassword }) });
    assert.equal(restrictedLogin.status, 201);
    const restrictedCookie = restrictedLogin.headers.get('set-cookie')?.split(';', 1)[0];
    const restrictedHeaders = { Cookie: restrictedCookie, 'Content-Type': 'application/json', 'X-Sepid-Request': '1' };
    assert.equal((await fetch(origin + '/api/v1/backups', { headers: { Cookie: restrictedCookie } })).status, 403);
    assert.equal((await fetch(origin + `/api/v1/backups/${backupName}`, { headers: { Cookie: restrictedCookie } })).status, 403);
    assert.equal((await fetch(origin + '/api/v1/people', { headers: { Cookie: restrictedCookie } })).status, 403);
    const limitedOptions = await (await fetch(origin + '/api/v1/machines/options', { headers: { Cookie: restrictedCookie } })).json();
    assert(limitedOptions.people.length > 0);
    assert(!('phone' in limitedOptions.people[0]) && !('note' in limitedOptions.people[0]));
    assert.equal((await fetch(origin + '/api/v1/models', { method: 'POST', headers: restrictedHeaders,
      body: JSON.stringify({ name: 'مدل غیرمجاز' }) })).status, 403);
    assert.equal((await fetch(origin + '/api/v1/machines', { method: 'POST', headers: restrictedHeaders,
      body: JSON.stringify({ code: 'ماشین غیرمجاز', unit: 'km' }) })).status, 403);

    const initialCatalog = await (await fetch(origin + '/api/v1/parts', { headers: { Cookie: cookie } })).json();
    const machineModel = await base.query(`SELECT model_id FROM ${schema}.machines WHERE id='m1'`);
    const initialModel = initialCatalog.models.find(model => model.id === machineModel.rows[0]?.model_id);
    assert(initialModel, 'initial fleet must include at least one model');
    const initialPartResponse = await fetch(origin + '/api/v1/parts', {
      method: 'POST', headers,
      body: JSON.stringify({ model_id: initialModel.id, name: 'قطعهٔ سرویس اولیهٔ آزمایشی', system: 'آزمون', interval_km: 5000, interval_hours: 0, interval_months: 6, action:'s', note:'توضیح اولیه', consequence:'پیامد اولیه' }),
    });
    assert.equal(initialPartResponse.status, 201, await initialPartResponse.clone().text());
    const initialPart = await initialPartResponse.json();
    const editedInitialPart = await fetch(origin + `/api/v1/parts/${initialPart.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ model_id: initialModel.id, name: 'قطعهٔ سرویس اولیهٔ آزمایشی', system: 'آزمون ویرایش‌شده', interval_km: 6000, interval_hours: 0, interval_months: 8, action:'a', note:'توضیح ویرایش‌شده', consequence:'پیامد ویرایش‌شده' }),
    });
    assert.equal(editedInitialPart.status, 200, await editedInitialPart.clone().text());
    const editedCatalog = await (await fetch(origin + '/api/v1/parts', { headers: { Cookie: cookie } })).json();
    assert.equal(editedCatalog.parts.find(part=>part.id===initialPart.id).consequence,'پیامد ویرایش‌شده');
    const serviceWithoutReading=await fetch(origin+'/api/v1/maintenance/m1/services',{method:'POST',headers,body:JSON.stringify({part_id:initialPart.id,kind:'service',date:'2026-11-11',reading:null,note:'آزمون کارکرد نامشخص'})});
    assert.equal(serviceWithoutReading.status,201,await serviceWithoutReading.clone().text());
    const unknownService=await serviceWithoutReading.json();
    const serviceLogCheck=await base.query(`SELECT machine_id,part_id,recorded_on,reading,unit FROM ${schema}.part_logs WHERE id=$1`,[unknownService.id]);
    assert.equal(serviceLogCheck.rowCount,1,`service log was not persisted: ${JSON.stringify(serviceLogCheck.rows)}`);
    const unknownOverview=await (await fetch(origin+'/api/v1/maintenance',{headers:{Cookie:cookie}})).json();
    const unknownMaintenance=unknownOverview.parts.find(part=>part.id===initialPart.id&&part.machine_id==='m1');
    assert.equal(unknownMaintenance?.state,'unknown',`mileage-based maintenance must not be marked healthy while current mileage is missing: ${JSON.stringify(unknownMaintenance)}; log=${JSON.stringify(serviceLogCheck.rows[0])}`);
    const removeUnknownService=await fetch(origin+`/api/v1/maintenance/m1/services/${unknownService.id}`,{method:'DELETE',headers});
    assert.equal(removeUnknownService.status,200,await removeUnknownService.clone().text());
    const initialService = await fetch(origin + '/api/v1/maintenance/m1/services/bulk', {
      method: 'POST', headers,
      body: JSON.stringify({ date: '2026-11-12', reading: 100, note: 'آزمون سرویس اولیه', part_ids: [initialPart.id] }),
    });
    assert.equal(initialService.status, 201, await initialService.clone().text());
    assert.deepEqual(await initialService.json(), { created: 1 });
    const initialHistory = await (await fetch(origin + '/api/v1/maintenance/m1/history', { headers: { Cookie: cookie } })).json();
    assert(initialHistory.services.some(item => item.name === 'قطعهٔ سرویس اولیهٔ آزمایشی'));
    assert(initialHistory.readings.some(item => Number(item.reading) === 100));
    const deleteInitialPart = await fetch(origin + `/api/v1/parts/${initialPart.id}`, { method: 'DELETE', headers });
    assert.equal(deleteInitialPart.status, 200, await deleteInitialPart.clone().text());
    assert.deepEqual(await deleteInitialPart.json(), { deleted: true, history_preserved: true });
    const preservedHistory = await (await fetch(origin + '/api/v1/maintenance/m1/history', { headers: { Cookie: cookie } })).json();
    assert(preservedHistory.services.some(item => item.name === 'قطعهٔ سرویس اولیهٔ آزمایشی'));
    const deleteInitialService = await fetch(origin + `/api/v1/maintenance/m1/services/${preservedHistory.services[0].id}`, { method: 'DELETE', headers });
    assert.equal(deleteInitialService.status, 200, await deleteInitialService.clone().text());
    const deletedHistory = await (await fetch(origin + '/api/v1/maintenance/m1/history', { headers: { Cookie: cookie } })).json();
    assert(!deletedHistory.services.some(item => item.name === 'قطعهٔ سرویس اولیهٔ آزمایشی'));
    await base.query(`DELETE FROM ${schema}.part_logs WHERE machine_id='m1' AND note='آزمون سرویس اولیه'`);
    await base.query(`DELETE FROM ${schema}.odometer_logs WHERE machine_id='m1' AND note='کارکرد ثبت‌شده همراه سرویس اولیه'`);
    await base.query(`DELETE FROM ${schema}.model_parts WHERE id=$1`, [initialPart.id]);

    const before = await (await fetch(origin + '/api/v1/settings', { headers: { Cookie: cookie } })).json();
    const stages = [
      { id: 'report', label: 'اعلام خرابی', kind: 'report', mode:'report', loc:'factory', who:'سرپرست', desc:'ثبت خرابی', limit: null },
      { id: 'wait', label: 'در انتظار قطعه یا خدمات', kind: 'step', mode:'wait', loc:'part', who:'تعمیرات', desc:'انتظار قطعه', limit: 7 },
      { id: 'inspect', label: 'بازرسی اولیه', kind: 'step', mode:'step', loc:'shop', who:'بازرس', desc:'بررسی اولیه', limit: 4 },
      { id: 'done', label: 'پایان تعمیر', kind: 'step', mode:'done', loc:'shop', who:'تعمیرات', desc:'اتمام کار', limit: 2 },
      { id: 'test', label: 'تست سلامت', kind: 'test', mode:'test', loc:'done', who:'سرپرست', desc:'آزمون در کارخانه', limit: null },
    ];
    const nextPayload = { ...before.payload, stages, companyName: 'شرکت آزمایشی API', analysisRules: {
      driver: { low: [{min:1,max:null,action:'اقدام آزمایشی'}], mid: [{min:1,max:null,action:'اقدام آزمایشی'}], high: [{min:1,max:null,action:'اقدام آزمایشی'}] },
      pm: { low: [{min:1,max:null,action:'اقدام آزمایشی'}], mid: [{min:1,max:null,action:'اقدام آزمایشی'}], high: [{min:1,max:null,action:'اقدام آزمایشی'}] },
    } };
    const saved = await fetch(origin + '/api/v1/settings', {
      method: 'PUT', headers, body: JSON.stringify({ ...nextPayload, revision: before.revision }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await (await fetch(origin + '/api/v1/repairs/stages', { headers: { Cookie: cookie } })).json(), stages);
    const afterStageCreateUsers=await (await fetch(origin+'/api/v1/users',{headers:{Cookie:cookie}})).json();
    assert(afterStageCreateUsers.find(user=>user.username===`restricted_${username}`).stages.includes('inspect'),'users allowed to register the previous stage should receive permission for a newly inserted stage');
    const invalidLimit = await fetch(origin + '/api/v1/settings', { method: 'PUT', headers,
      body: JSON.stringify({ ...nextPayload, revision: (await saved.clone().json()).revision, stages: stages.map((stage,index)=>index===1?{...stage,limit:366}:stage) }) });
    assert.equal(invalidLimit.status, 400, 'stage delay limit must be bounded');
    assert.equal((await (await fetch(origin + '/api/v1/settings/brand', { headers: { Cookie: cookie } })).json()).companyName,
      'شرکت آزمایشی API');
    const legacy = await (await fetch(origin + '/api/v1/legacy-workspace', { headers: { Cookie: cookie } })).json();
    assert.equal(legacy.payload.settings.companyName, 'شرکت آزمایشی API');
    assert.equal(legacy.payload.schema, 4);
    assert.equal(legacy.payload.rules.driver.high[0].action, 'اقدام آزمایشی');
    const oldWorkspace = {
      schema: 4, settings: { companyName: 'نسخهٔ قدیمی', stages: [
        { sid: 'old-report', label: 'اعلام خرابی', kind: 'report' },
        { sid: 'old-wait', label: 'در انتظار تعمیرگاه', kind: 'step', loc: 'factory', limit: 3 },
        { sid: 'old-test', label: 'تست سلامت', kind: 'test' },
      ] },
      models: [{ id: 'FM', name: 'ولوو FM', brand: 'Volvo' }, { id: 'ZL30', name: 'لودر ZL30', brand: 'ZL30' }],
      people: [
        { id: 'p1', name: 'علی محمدی', role: 'driver', active: true },
        { id: 'p8', name: 'عبدالکریم موغفاری', role: 'supervisor', active: true },
        { id: 'p9', name: 'علی شبانی', role: 'pm', active: true },
      ],
      machines: [{ id: 'm1', code: 'FM 414', plate: '414ع79', type: 'ده تن', model: 'FM', driverId: 'p1', supervisorId: 'p8', pmId: 'p9', unit: 'km', active: true },
        { id: 'm7', code: 'ZL30', type: 'لودر', model: 'ZL30', supervisorId: 'p8', pmId: 'p9', unit: 'hour', note: 'راننده ثابت ندارد', floating: true, active: true }],
      catalog: { FM: [{ id: 'engine-oil', name: 'روغن موتور', sys: 'موتور', km: 5000, hr: 0, mo: 6, act: 'r', alts: [{ id: 'oil-alt', name: 'روغن جایگزین', ok: true }] }] },
      odoLogs: [{ id: 'odo-old-1', machineId: 'm1', date: '1405/08/21', value: 12345, note: 'ثبت قدیمی' }],
      partLogs: [{ id: 'part-old-1', machineId: 'm1', partId: 'engine-oil', date: '1405/08/20', km: 12000, note: 'تعویض قدیمی' }],
      repairs: [{ id: 'repair-old-1', machineId: 'm1', type: 'خرابی آزمایشی قدیمی', urgency: 'urgent', reportDate: '1405/08/21', returnDate: '1405/08/22',
        track: [{ sid: 'old-report', at: '2026-11-11T08:00:00Z', byName: 'مسئول قدیمی' }, { sid: 'old-test', at: '2026-11-12T08:00:00Z', result: 'old' }],
        test: { result: 'old' } }],
      analyses: [{ id: 'analysis-old-1', machineId: 'm1', repairId: 'repair-old-1', date: '1405/08/21', topic: 'تحلیل قدیمی', cause: 'علت', severity: 'low', q1: 'yes' },
        { id: 'analysis-old-floating', machineId: 'm7', date: '1405/08/21', topic: 'رانندهٔ روزانه', severity: 'low', driverName: 'رانندهٔ موقت' }],
      rules: {},
    };
    const savedWorkspace = await fetch(origin + '/api/v1/legacy-workspace', {
      method: 'PUT', headers, body: JSON.stringify({ revision: legacy.revision, payload: oldWorkspace }),
    });
    assert.equal(savedWorkspace.status, 200);
    const migrationPreview = await (await fetch(origin + '/api/v1/legacy-workspace/migration-preview', { headers: { Cookie: cookie } })).json();
    assert.equal(migrationPreview.canImport, true, JSON.stringify(migrationPreview.issues));
    assert.equal(migrationPreview.counts.repairs, 1);
    const migrated = await fetch(origin + '/api/v1/legacy-workspace/import-operations', { method: 'POST', headers,
      body: JSON.stringify({ revision: migrationPreview.revision }) });
    assert.equal(migrated.status, 201, `${await migrated.clone().text()}\n${childOutput}`);
    const importResult = await migrated.json();
    assert.deepEqual(importResult.counts, { models: 2, people: 3, machines: 2, repairs: 1, events: 2, analyses: 2,
      parts: 1, alternatives: 1, partLogs: 1, odometerLogs: 1 });
    const repeatedImport = await fetch(origin + '/api/v1/legacy-workspace/import-operations', { method: 'POST', headers,
      body: JSON.stringify({ revision: migrationPreview.revision }) });
    assert.equal(repeatedImport.status, 201);
    assert.equal((await repeatedImport.json()).alreadyImported, true);
    const verifyPool = new Pool({ connectionString: isolated.href });
    try {
      const migratedRepair = await verifyPool.query('SELECT title,stage,result,report_date FROM repairs');
      assert.equal(migratedRepair.rows[0].title, 'خرابی آزمایشی قدیمی');
      assert.equal(migratedRepair.rows[0].result, 'old', 'legacy closed repairs without a health-test result should remain classified as pre-test, not pass');
      assert.equal(migratedRepair.rows[0].report_date.toISOString().slice(0, 10), '2026-11-11');
      const migratedTest = await verifyPool.query("SELECT result,note FROM repair_events WHERE repair_id=(SELECT id FROM repairs WHERE title='خرابی آزمایشی قدیمی') AND result IS NOT NULL");
      assert.equal(migratedTest.rows[0].result, 'old');
      const floatingMachine = await verifyPool.query("SELECT floating_driver,driver_id FROM machines WHERE id='m7'");
      assert.deepEqual(floatingMachine.rows[0], { floating_driver: true, driver_id: null });
      const importedOrder=await verifyPool.query('SELECT code FROM machines ORDER BY sort_order,id');
      assert.deepEqual(importedOrder.rows.slice(0,2).map(row=>row.code),['FM 414','ZL30'],
        'imported machine order should precede leftover starter rows and match the legacy file');
      const nextMachineOrder=await verifyPool.query("SELECT nextval('machine_sort_order_seq') AS value,(SELECT max(sort_order) FROM machines) AS maximum");
      assert(Number(nextMachineOrder.rows[0].value)>Number(nextMachineOrder.rows[0].maximum),
        'newly created machines should append after imported and retained rows');
      const floatingAnalysis = await verifyPool.query("SELECT responses->>'driver_name' AS driver_name,responses->>'driver_id' AS driver_id FROM analyses WHERE machine_id='m7'");
      assert.deepEqual(floatingAnalysis.rows[0], { driver_name: 'رانندهٔ موقت', driver_id: null });
    } finally { await verifyPool.end(); }
    const cleanup = new Pool({ connectionString: isolated.href });
    try { await cleanup.query('TRUNCATE analyses,repair_events,repairs,part_logs,part_alternatives,model_parts,odometer_logs,legacy_import_batches RESTART IDENTITY CASCADE'); }
    finally { await cleanup.end(); }
    const importedSettings = await (await fetch(origin + '/api/v1/settings', { headers: { Cookie: cookie } })).json();
    const restoredSettings = await fetch(origin + '/api/v1/settings', { method: 'PUT', headers,
      body: JSON.stringify({ ...nextPayload, revision: importedSettings.revision }) });
    assert.equal(restoredSettings.status, 200, await restoredSettings.clone().text());
    const repairResponse = await fetch(origin + '/api/v1/repairs', {
      method: 'POST', headers,
      body: JSON.stringify({ machine_id: 'm1', report_date: '2026-11-12', title: 'آزمون جزئیات پرونده', urgency: 'urgent',
        diagnoser: 'مسئول آزمایشی', expected_date: '2026-11-20', shop: 'تعمیرگاه آزمایشی', repairer_note: 'یادداشت تعمیرکار',
        delay_reason: 'علت آزمایشی', note: 'آزمون schema موقت' }),
    });
    assert.equal(repairResponse.status, 201);
    const repair = await repairResponse.json();
    assert.equal(repair.report_date, '2026-11-12');
    assert.equal(repair.diagnoser, 'مسئول آزمایشی');
    assert.equal(repair.expected_date, '2026-11-20');
    assert.equal(repair.repairer_note, 'یادداشت تعمیرکار');
    assert.equal(repair.delay_reason, 'علت آزمایشی');
    const editedRepairResponse = await fetch(origin + `/api/v1/repairs/${repair.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ machine_id: 'm1', version: repair.version, report_date: repair.report_date, title: repair.title,
        urgency: repair.urgency, diagnoser: 'مسئول اصلاح‌شده', expected_date: repair.expected_date, shop: repair.shop,
        repairer_note: 'نظر اصلاح‌شده', delay_reason: repair.delay_reason, note: repair.note }),
    });
    const exceptionLog = childOutput.split(/\r?\n/).filter(line => /ERROR|ExceptionsHandler|Repair update failed/i.test(line)).join('\n');
    const editedRepairText = await editedRepairResponse.text();
    assert.equal(editedRepairResponse.status, 200, `${editedRepairText}\n${exceptionLog}`);
    const editedRepair = JSON.parse(editedRepairText);
    assert.equal(editedRepair.version, repair.version + 1);
    assert.equal(editedRepair.diagnoser, 'مسئول اصلاح‌شده');
    assert.equal(editedRepair.repairer_note, 'نظر اصلاح‌شده');
    assert.deepEqual((await base.query(`SELECT workflow FROM ${schema}.repairs WHERE id=$1`, [editedRepair.id])).rows[0].workflow,
      ['report','wait','inspect','done','test']);
    const configuredAfterCreate = await fetch(origin + '/api/v1/settings', { headers: { Cookie: cookie } }).then(response=>response.json());
    const reordered = [...stages];[reordered[1],reordered[2]]=[reordered[2],reordered[1]];
    const reorderedResponse = await fetch(origin + '/api/v1/settings', {
      method: 'PUT', headers, body: JSON.stringify({ ...configuredAfterCreate.payload, revision: configuredAfterCreate.revision, stages: reordered }),
    });
    assert.equal(reorderedResponse.status, 200, await reorderedResponse.text());
    let flowingRepair = editedRepair;
    for (const [previous, result] of [['report',null],['wait',null],['inspect',null],['done','pass']]) {
      const response = await fetch(origin + `/api/v1/repairs/${flowingRepair.id}/events`, {
        method: 'POST', headers,
        body: JSON.stringify({ previous, version: flowingRepair.version, note: `مرحله ${previous}`, result,
          ...(previous==='report'?{shop:'تعمیرگاه آزمون',part_name:'پمپ آزمایشی',part_status:'shipping',part_vendor:'فروشنده آزمون',part_eta:'2026-11-14',expected_date:'2026-11-19',event_date:'2026-11-12',event_time:'09:40'}:{}) }),
      });
      if (response.status !== 201) throw new Error(`Dynamic stage advance failed (${response.status}): ${await response.text()}`);
      flowingRepair = await response.json();
      if(previous==='report'){
        const repeat=await fetch(origin+`/api/v1/repairs/${flowingRepair.id}/events`,{method:'POST',headers,
          body:JSON.stringify({previous:'wait',version:flowingRepair.version,repeat_current:true,note:'به‌روزرسانی آزمون',part_name:'پمپ به‌روزشده',part_status:'arrived'})});
        assert.equal(repeat.status,201,await repeat.clone().text());
        flowingRepair=await repeat.json();
        assert.equal(flowingRepair.stage,'wait');
        const undoRepeat=await fetch(origin+`/api/v1/repairs/${flowingRepair.id}/events/undo`,{method:'POST',headers,
          body:JSON.stringify({version:flowingRepair.version})});
        assert.equal(undoRepeat.status,201,await undoRepeat.clone().text());
        flowingRepair=await undoRepeat.json();
        assert.equal(flowingRepair.stage,'wait');
        const repeatedEvents=(await base.query(`SELECT revision,voided_at FROM ${schema}.repair_events WHERE repair_id=$1 AND stage='wait' ORDER BY revision`,[flowingRepair.id])).rows;
        assert.equal(repeatedEvents.length,2);
        assert.equal(repeatedEvents[0].voided_at,null);
        assert(repeatedEvents[1].voided_at);
      }
    }
    assert.equal(flowingRepair.stage, 'test');
    assert.equal(flowingRepair.result, 'pass');
    assert.equal(flowingRepair.shop,'تعمیرگاه آزمون');
    assert.equal(flowingRepair.expected_date,'2026-11-19');
    const waitEvent=(await base.query(`SELECT details,to_char(recorded_at AT TIME ZONE 'Asia/Tehran','YYYY-MM-DD HH24:MI') AS recorded_at FROM ${schema}.repair_events WHERE repair_id=$1 AND stage='wait' ORDER BY revision LIMIT 1`,[flowingRepair.id])).rows[0];
    assert.equal(waitEvent.details.part_name,'پمپ آزمایشی');
    assert.equal(waitEvent.details.part_status,'shipping');
    assert.equal(waitEvent.details.part_vendor,'فروشنده آزمون');
    assert(waitEvent.recorded_at.startsWith('2026-11-12 09:40'));
    assert.deepEqual((await base.query(`SELECT stage FROM ${schema}.repair_events WHERE repair_id=$1 ORDER BY revision`, [editedRepair.id])).rows,
      [{stage:'report'},{stage:'wait'},{stage:'wait'},{stage:'inspect'},{stage:'done'},{stage:'test'}]);
    const scopedRepairResponse=await fetch(origin+'/api/v1/repairs',{method:'POST',headers,body:JSON.stringify({machine_id:'m2',title:'پرونده تعمیرگاه',urgency:'d13',shop:'تعمیرگاه',note:'',diagnoser:'',repairer_note:'',delay_reason:''})});
    if(scopedRepairResponse.status!==201)throw new Error(`Scoped repair create failed (${scopedRepairResponse.status}): ${await scopedRepairResponse.text()}`);
    let scopedRepair=await scopedRepairResponse.json();
    const firstStep=await fetch(origin+`/api/v1/repairs/${scopedRepair.id}/events`,{method:'POST',headers,body:JSON.stringify({previous:'report',version:scopedRepair.version,note:'ارسال به تعمیرگاه',result:null})});
    if(firstStep.status!==201)throw new Error(`Scoped repair advance failed (${firstStep.status}): ${await firstStep.text()}`);
    scopedRepair=await firstStep.json();
    const scopedUsername=`repair_${randomBytes(4).toString('hex')}`;
    const scopedPassword=randomBytes(18).toString('base64url');
    const scopedUser=await fetch(origin+'/api/v1/users',{method:'POST',headers,body:JSON.stringify({username:scopedUsername,name:'کاربر تعمیرگاه',active:true,password:scopedPassword,phone:'',receive_sms:false,scope_shop:true,permissions:{status:1,repairs:1},stages:[]})});
    if(scopedUser.status!==201)throw new Error(`Scoped user create failed (${scopedUser.status}): ${await scopedUser.text()}`);
    const scopedLogin=await fetch(origin+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Sepid-Request':'1'},body:JSON.stringify({username:scopedUsername,password:scopedPassword})});
    assert.equal(scopedLogin.status,201);
    const scopedCookie=scopedLogin.headers.get('set-cookie')?.split(';',1)[0];
    const scopedStages=await (await fetch(origin+'/api/v1/auth/me',{headers:{Cookie:scopedCookie}})).json();
    assert.equal(scopedStages.scope_shop,true);
    assert.deepEqual(scopedStages.stages,[]);
    const scopedOverview=await (await fetch(origin+'/api/v1/status',{headers:{Cookie:scopedCookie}})).json();
    assert.equal(scopedOverview.scope_shop,true);
    assert.deepEqual(scopedOverview.machines,[]);
    assert.deepEqual(scopedOverview.repairs.map(row=>row.id),[scopedRepair.id]);
    assert.deepEqual((await (await fetch(origin+'/api/v1/repairs',{headers:{Cookie:scopedCookie}})).json()).map(row=>row.id),[scopedRepair.id]);
    for (const [previous,result] of [['inspect',null],['wait',null],['done','fail']]) {
      const response=await fetch(origin+`/api/v1/repairs/${scopedRepair.id}/events`,{method:'POST',headers,body:JSON.stringify({previous,version:scopedRepair.version,note:`مرحله ${previous}`,result})});
      if(response.status!==201)throw new Error(`Rejected test workflow failed (${response.status}): ${await response.text()}`);
      scopedRepair=await response.json();
    }
    assert.equal(scopedRepair.result,'fail');
    const followupResponse=await fetch(origin+'/api/v1/repairs',{method:'POST',headers,body:JSON.stringify({machine_id:'m2',title:'خرابی پس از تست رد شده',urgency:'d13',shop:'تعمیرگاه',note:'',diagnoser:'',repairer_note:'',delay_reason:'',previous_repair_id:scopedRepair.id})});
    if(followupResponse.status!==201)throw new Error(`Follow-up repair create failed (${followupResponse.status}): ${await followupResponse.text()}`);
    const followupRepair=await followupResponse.json();
    assert.equal(followupRepair.previous_repair_id,scopedRepair.id);
    assert.equal(String(followupRepair.previous_repair_number),String(scopedRepair.number));
    const duplicateFollowup=await fetch(origin+'/api/v1/repairs',{method:'POST',headers,body:JSON.stringify({machine_id:'m2',title:'پروندهٔ تکراری',urgency:'none',shop:'',note:'',diagnoser:'',repairer_note:'',delay_reason:'',previous_repair_id:scopedRepair.id})});
    assert.equal(duplicateFollowup.status,400);
    const undoneResponse=await fetch(origin+`/api/v1/repairs/${flowingRepair.id}/events/undo`,{method:'POST',headers,
      body:JSON.stringify({version:flowingRepair.version})});
    assert.equal(undoneResponse.status,201,await undoneResponse.clone().text());
    const undoneRepair=await undoneResponse.json();
    assert.equal(undoneRepair.stage,'done');
    assert.equal(undoneRepair.result,null);
    assert.equal(undoneRepair.version,flowingRepair.version+1);
    assert.equal(undoneRepair.shop,'تعمیرگاه آزمون');
    assert.equal(undoneRepair.expected_date,'2026-11-19');
    const undoneHistory=await (await fetch(origin+`/api/v1/repairs/${flowingRepair.id}/events`,{headers:{Cookie:cookie}})).json();
    assert.equal(undoneHistory.length,6);
    assert(undoneHistory.at(-1).voided_at);
    assert.equal(undoneHistory.at(-1).undoable,false);
    const repairReport = await (await fetch(origin + '/api/v1/reports/repairs', { headers: { Cookie: cookie } })).json();
    const editedReportRow=repairReport.find(row=>row.title==='آزمون جزئیات پرونده');
    assert.equal(editedReportRow.report_date, '2026-11-12');
    assert.equal(editedReportRow.diagnoser, 'مسئول اصلاح‌شده');
    const analysisOptions = await (await fetch(origin + '/api/v1/analyses/options', { headers: { Cookie: cookie } })).json();
    assert(analysisOptions.machines.some(machine => machine.id === 'm1' && machine.driver_id === 'p1'));
    assert(analysisOptions.machines.some(machine => machine.id === 'm7' && machine.floating_driver === true),
      'analysis machine options should preserve the variable-driver flag');
    assert(analysisOptions.people.some(person => person.id === 'p1' && person.role === 'driver'));
    assert.equal(analysisOptions.rules.driver.low[0].action, 'اقدام آزمایشی');
    assert.equal(analysisOptions.countWindow, 'all');
    const analysisResponse = await fetch(origin + '/api/v1/analyses', {
      method: 'POST', headers,
      body: JSON.stringify({ machine_id: 'm1', date: '2026-11-12', topic: 'آزمون تحلیل', cause: 'علت آزمایشی', severity: 'medium',
        responses: { q1: 'yes', q1b: 'no', q2: 'no', driver_id: 'p1', pm_id: 'p9' },
        goldratt: { ude: 'اثر', root: 'علت', change: 'راهکار' }, note: '' }),
    });
    assert.equal(analysisResponse.status, 201);
    const createdAnalysis = await analysisResponse.json();
    assert.equal(createdAnalysis.machine_id, 'm1');
    assert.equal(createdAnalysis.machine_code, analysisOptions.machines.find(machine => machine.id === 'm1').code);
    assert(createdAnalysis.created_at);
    const editedAnalysisResponse=await fetch(origin+`/api/v1/analyses/${createdAnalysis.id}`,{method:'PATCH',headers,
      body:JSON.stringify({machine_id:'m1',date:'2026-11-10',topic:'تحلیل ویرایش‌شده',cause:'علت ویرایش‌شده',severity:'low',
        responses:{q1:'no',q2:'no',q3:'yes',q3note:'فشار آزمایشی',driver_id:'p1',pm_id:'p9'},
        goldratt:{ude:'اثر ویرایش‌شده',root:'ریشه ویرایش‌شده',change:'راهکار ویرایش‌شده'},note:'یادداشت ویرایش‌شده'})});
    assert.equal(editedAnalysisResponse.status,200,await editedAnalysisResponse.clone().text());
    const editedAnalysis=await editedAnalysisResponse.json();
    assert.equal(editedAnalysis.topic,'تحلیل ویرایش‌شده');
    assert.equal(editedAnalysis.responses.q3note,'فشار آزمایشی');
    assert.equal(editedAnalysis.goldratt.root,'ریشه ویرایش‌شده');
    console.log('API smoke passed: migrations, initial fleet, first-admin setup/closure, five-attempt account lockout, correct-password rejection during lock, login recovery, self-service password rotation with current-session preservation and other-session revocation, controlled SMS retries and retry cap, uncertain-message retry rejection, admin-only backup list/download and path validation, settings, legacy backup import/idempotency, maintenance part create/edit/delete with preserved history, bulk service logging, configurable repair stages, repeat-stage repair updates, reversible audit history, full repair fields, and analysis create/edit.');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (created) await base.query(`DROP SCHEMA ${schema} CASCADE`);
    await rm(backupDirectory, { recursive: true, force: true });
    await base.end();
  }
}

run().catch(error => {
  console.error('API smoke failed:', error.message);
  process.exitCode = 1;
});
