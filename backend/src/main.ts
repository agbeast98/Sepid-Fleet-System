import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Injectable,
  Module,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  Res,
  ServiceUnavailableException,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { argon2, createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspectLegacyData, legacyData, legacyDate, legacyFloatingDriver, legacyStages, legacyUuid } from './legacy-migration';
import { importLegacyOperations } from './legacy-importer';
import { openApiDocument } from './openapi';
import { sendSmsIr, smsIrDelivery, smsProviderConfigured, type SmsIrPattern } from './sms-ir';
import { effectiveSmsIr, encryptSmsKey, selectedSmsProvider, smsEncryptionKey, storedSmsIr } from './sms-ir-settings';
import { effectiveIPPanel, ippanelDelivery, listIPPanelPatterns, normalizeIPPanelSender, sendIPPanel, storedIPPanel, type IPPanelPattern } from './sms-ippanel';

@Injectable()
class Database implements OnApplicationShutdown {
  readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    this.pool = new Pool({ connectionString, connectionTimeoutMillis: 2500 });
    this.pool.on('error', () => console.error('Idle PostgreSQL connection failed'));
  }

  async checkReady(): Promise<void> {
    await this.pool.query('SELECT id FROM repairs LIMIT 1; SELECT id FROM model_parts LIMIT 1');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

type RequestHeaders = { headers: Record<string, string | string[] | undefined> };
type ResponseHeaders = { setHeader(name: string, value: string): void };
type Account = { id: string; name: string; is_super_admin: boolean; scope_shop: boolean; password_hash?: string };

function hashPassword(password: string, nonce: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', {
      message: password, nonce, memory: 65536, passes: 3, parallelism: 1, tagLength: 32,
    }, (error, result) => error ? reject(error) : resolve(result));
  });
}

const dummySalt = randomBytes(16);
const sessionSeconds = 8 * 60 * 60;

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function sessionToken(request: RequestHeaders): string {
  const cookie = request.headers.cookie;
  if (typeof cookie !== 'string') return '';
  return /(?:^|;\s*)sepid_session=([a-f0-9]{64})(?:;|$)/.exec(cookie)?.[1] ?? '';
}

function requireMutationHeader(request: RequestHeaders): void {
  if (request.headers['x-sepid-request'] !== '1') throw new ForbiddenException();
}

function sessionCookie(token: string, maxAge?: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const lifetime = maxAge === undefined ? '' : `; Max-Age=${maxAge}`;
  return `sepid_session=${token}; Path=/; HttpOnly; SameSite=Strict${lifetime}${secure}`;
}

function inputText(value: unknown, limit: number, required = false): string {
  if (typeof value !== 'string' || value.trim().length > limit || (required && !value.trim())) {
    throw new BadRequestException('Invalid field value');
  }
  return value.trim();
}

@Injectable()
class Auth {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly otpRequestAttempts = new Map<string,{count:number;until:number}>();
  private inFlight = 0;

  constructor(private readonly database: Database) {}

  async bootstrap(): Promise<void> {
    const username = process.env.SEPID_ADMIN_USERNAME?.trim();
    const password = process.env.SEPID_ADMIN_PASSWORD;
    if (!username && !password) return;
    if (!username || username.length > 100 || !password || password.length < 12 || password.length > 256) {
      throw new Error('Set a username and a 12–256 character administrator password');
    }
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const existing = await client.query('SELECT 1 FROM users WHERE is_super_admin LIMIT 1');
      if (!existing.rowCount) {
        const salt = randomBytes(16);
        const hash = await hashPassword(password, salt);
        await client.query(
          'INSERT INTO users(id, username, name, password_hash, is_super_admin) VALUES ($1, $2, $3, $4, true)',
          [randomUUID(), username, 'مدیر کل', `${salt.toString('hex')}:${hash.toString('hex')}`],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async login(username: string, password: string, address: string): Promise<string> {
    const now = Date.now();
    for (const [key, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(key);
    const key = address;
    const attempt = this.attempts.get(key) ?? { count: 0, until: now + 60_000 };
    if (attempt.count >= 12 || this.inFlight >= 4 || this.attempts.size >= 10_000) {
      throw new ForbiddenException('Too many attempts');
    }
    attempt.count += 1;
    this.attempts.set(key, attempt);
    this.inFlight += 1;
    try {
      const client = await this.database.pool.connect();
      let committed = false;
      try {
        await client.query('BEGIN');
        const result = await client.query<Account & { failed_login_attempts: number; login_locked_until: Date | null }>(
          'SELECT id, password_hash, failed_login_attempts, login_locked_until FROM users WHERE lower(username) = lower($1) AND active FOR UPDATE',
          [username],
        );
        const account = result.rows[0];
        const stored = /^([a-f0-9]{32}):([a-f0-9]{64})$/.exec(account?.password_hash ?? '');
        const hash = await hashPassword(password, stored ? Buffer.from(stored[1], 'hex') : dummySalt);
        const valid = Boolean(stored && timingSafeEqual(hash, Buffer.from(stored![2], 'hex')));
        const locked = Boolean(account?.login_locked_until && account.login_locked_until.getTime() > Date.now());
        if (locked) {
          await client.query('COMMIT');
          committed = true;
          throw new ForbiddenException('حساب کاربری به‌دلیل تلاش‌های ناموفق قفل است. ۱۵ دقیقه بعد دوباره تلاش کنید.');
        }
        if (!valid) {
          const priorAttempts = account?.login_locked_until ? 0 : account?.failed_login_attempts ?? 0;
          const failedAttempts = account ? priorAttempts + 1 : 0;
          if (account) await client.query(
            `UPDATE users SET failed_login_attempts=$2,
               login_locked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE NULL END
             WHERE id=$1`, [account.id, failedAttempts],
          );
          await client.query('COMMIT');
          committed = true;
          if (account && failedAttempts >= 5) throw new ForbiddenException('پس از ۵ بار رمز اشتباه، حساب برای ۱۵ دقیقه قفل شد.');
          throw new UnauthorizedException('نام کاربری یا رمز عبور نادرست است.');
        }
        const token = randomBytes(32).toString('hex');
        await client.query('UPDATE users SET failed_login_attempts=0, login_locked_until=NULL, last_login=now() WHERE id=$1', [account!.id]);
        await client.query(
          "INSERT INTO sessions(token_digest, user_id, expires_at) VALUES ($1, $2, now() + interval '8 hours')",
          [digest(token), account!.id],
        );
        await client.query('COMMIT');
        committed = true;
        return token;
      } catch (error) {
        if (!committed) await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    } finally {
      this.inFlight -= 1;
    }
  }

  async otpAvailable():Promise<boolean>{
    const stored=await storedSmsIr(this.database.pool);
    const provider=selectedSmsProvider(stored);
    if(provider==='smsir')return Boolean(stored?.login_template_id&&effectiveSmsIr(stored)?.apiKey);
    if(provider==='ippanel')return Boolean(stored?.ippanel_login_pattern_code&&effectiveIPPanel(await storedIPPanel(this.database.pool))?.apiKey);
    return false;
  }

  async requestLoginCode(rawPhone:string,address:string):Promise<void>{
    const now=Date.now();
    for(const [key,value] of this.otpRequestAttempts)if(value.until<=now)this.otpRequestAttempts.delete(key);
    const ipKey=address||'unknown';const limit=this.otpRequestAttempts.get(ipKey)??{count:0,until:now+15*60_000};
    if(limit.count>=5||this.otpRequestAttempts.size>=10_000)throw new ForbiddenException('درخواست کد ورود بیش از حد مجاز است. کمی بعد دوباره امتحان کنید.');
    limit.count++;this.otpRequestAttempts.set(ipKey,limit);
    const phone=normalizedSmsPhone(rawPhone);
    if(!/^09\d{9}$/.test(phone)||!(await this.otpAvailable()))return;
    const candidates=await this.database.pool.query<{id:string;phone:string;name:string}>('SELECT id,phone,name FROM users WHERE active AND phone<>\'\'');
    const accounts=candidates.rows.filter(item=>normalizedSmsPhone(item.phone)===phone);
    if(accounts.length!==1)return;
    const prior=await this.database.pool.query("SELECT 1 FROM sms_login_challenges WHERE phone=$1 AND last_sent_at>now()-interval '60 seconds'",[phone]);
    if(prior.rowCount)return;
    const stored=await storedSmsIr(this.database.pool);const provider=selectedSmsProvider(stored);
    const smsIrConfig=provider==='smsir'?effectiveSmsIr(stored):null;
    const panelConfig=provider==='ippanel'?effectiveIPPanel(await storedIPPanel(this.database.pool)):null;
    if((provider==='smsir'&&(!stored?.login_template_id||!smsIrConfig))||(provider==='ippanel'&&(!stored?.ippanel_login_pattern_code||!panelConfig)))return;
    const code=String(randomInt(100000,1000000));const salt=randomBytes(16).toString('hex');
    const codeDigest=createHash('sha256').update(`${salt}:${code}`).digest('hex');
    await this.database.pool.query(`INSERT INTO sms_login_challenges(phone,user_id,code_digest,salt,expires_at,attempts,last_sent_at,consumed_at)
      VALUES($1,$2,$3,$4,now()+interval '5 minutes',0,now(),NULL)
      ON CONFLICT(phone) DO UPDATE SET user_id=excluded.user_id,code_digest=excluded.code_digest,salt=excluded.salt,
        expires_at=excluded.expires_at,attempts=0,last_sent_at=now(),consumed_at=NULL`,[phone,accounts[0].id,codeDigest,salt]);
    const sent=provider==='smsir'
      ?await sendSmsIr(phone,'',smsIrConfig,{templateId:stored!.login_template_id!,parameters:[{name:'NAME',value:String(accounts[0].name??'').slice(0,25)},{name:'CODE',value:code}]})
      :await sendIPPanel(phone,'',panelConfig,{code:stored!.ippanel_login_pattern_code!,parameters:{
        ...(stored!.ippanel_name_parameter?{[stored!.ippanel_name_parameter]:String(accounts[0].name??'').slice(0,25)}:{}),
        [stored!.ippanel_code_parameter||'CODE']:code,
      }});
    if(sent.status!=='accepted')await this.database.pool.query('UPDATE sms_login_challenges SET consumed_at=now() WHERE phone=$1 AND code_digest=$2',[phone,codeDigest]);
  }

  async verifyLoginCode(rawPhone:string,code:string):Promise<string>{
    const phone=normalizedSmsPhone(rawPhone);
    if(!/^09\d{9}$/.test(phone)||!/^\d{6}$/.test(code))throw new UnauthorizedException('کد تأیید نامعتبر یا منقضی شده است.');
    const client=await this.database.pool.connect();let committed=false;
    try{
      await client.query('BEGIN');
      const result=await client.query<{user_id:string;code_digest:string;salt:string;expires_at:Date;attempts:number;consumed_at:Date|null}>(
        'SELECT user_id,code_digest,salt,expires_at,attempts,consumed_at FROM sms_login_challenges WHERE phone=$1 FOR UPDATE',[phone]);
      const challenge=result.rows[0];
      const actual=challenge?createHash('sha256').update(`${challenge.salt}:${code}`).digest('hex'):'';
      const valid=Boolean(challenge&&!challenge.consumed_at&&challenge.expires_at.getTime()>Date.now()&&challenge.attempts<5&&timingSafeEqual(Buffer.from(actual),Buffer.from(challenge.code_digest)));
      if(!challenge){await client.query('COMMIT');committed=true;throw new UnauthorizedException('کد تأیید نامعتبر یا منقضی شده است.');}
      if(!valid){await client.query('UPDATE sms_login_challenges SET attempts=LEAST(attempts+1,5) WHERE phone=$1',[phone]);await client.query('COMMIT');committed=true;throw new UnauthorizedException('کد تأیید نامعتبر یا منقضی شده است.');}
      const user=await client.query<{id:string;phone:string}>('SELECT id,phone FROM users WHERE id=$1 AND active FOR UPDATE',[challenge.user_id]);
      if(!user.rowCount||normalizedSmsPhone(user.rows[0].phone)!==phone){await client.query('UPDATE sms_login_challenges SET consumed_at=now() WHERE phone=$1',[phone]);await client.query('COMMIT');committed=true;throw new UnauthorizedException('کد تأیید نامعتبر یا منقضی شده است.');}
      const token=randomBytes(32).toString('hex');
      await client.query('INSERT INTO sessions(token_digest,user_id,expires_at) VALUES($1,$2,now()+interval \'8 hours\')',[digest(token),challenge.user_id]);
      await client.query('UPDATE sms_login_challenges SET consumed_at=now() WHERE phone=$1',[phone]);
      await client.query('UPDATE users SET last_login=now(),failed_login_attempts=0,login_locked_until=NULL WHERE id=$1',[challenge.user_id]);
      await client.query('COMMIT');committed=true;return token;
    }catch(error){if(!committed)await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  async logout(request: RequestHeaders): Promise<void> {
    const token = sessionToken(request);
    if (token) await this.database.pool.query('DELETE FROM sessions WHERE token_digest = $1', [digest(token)]);
  }

  async changePassword(request: RequestHeaders, currentPassword: string, newPassword: string): Promise<void> {
    const account = await this.current(request);
    const token = sessionToken(request);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ password_hash: string; failed_login_attempts: number; login_locked_until: Date | null }>(
        'SELECT password_hash,failed_login_attempts,login_locked_until FROM users WHERE id=$1 AND active FOR UPDATE', [account.id],
      );
      const stored = /^([a-f0-9]{32}):([a-f0-9]{64})$/.exec(result.rows[0]?.password_hash ?? '');
      if (!result.rows[0] || (result.rows[0].login_locked_until && result.rows[0].login_locked_until.getTime() > Date.now())) {
        await client.query('COMMIT');
        throw new ForbiddenException('حساب کاربری قفل است. ۱۵ دقیقه بعد دوباره تلاش کنید.');
      }
      const oldHash = await hashPassword(currentPassword, stored ? Buffer.from(stored[1], 'hex') : dummySalt);
      const valid = Boolean(stored && timingSafeEqual(oldHash, Buffer.from(stored![2], 'hex')));
      if (!valid) {
        const failedAttempts = (result.rows[0].login_locked_until ? 0 : result.rows[0].failed_login_attempts) + 1;
        await client.query(`UPDATE users SET failed_login_attempts=$2,
          login_locked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE id=$1`, [account.id, failedAttempts]);
        await client.query('COMMIT');
        if (failedAttempts >= 5) throw new ForbiddenException('پس از ۵ بار رمز فعلی اشتباه، حساب برای ۱۵ دقیقه قفل شد.');
        throw new UnauthorizedException('رمز فعلی درست نیست.');
      }
      if (currentPassword === newPassword) throw new BadRequestException('رمز جدید باید با رمز فعلی متفاوت باشد.');
      const salt = randomBytes(16);
      const encoded = `${salt.toString('hex')}:${(await hashPassword(newPassword, salt)).toString('hex')}`;
      await client.query('UPDATE users SET password_hash=$2,failed_login_attempts=0,login_locked_until=NULL WHERE id=$1', [account.id, encoded]);
      await client.query('DELETE FROM sessions WHERE user_id=$1 AND token_digest<>$2', [account.id, digest(token)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async setupRequired(): Promise<boolean> {
    if (process.env.NODE_ENV === 'production' && process.env.SEPID_ALLOW_ADMIN_SETUP !== 'true') return false;
    const result = await this.database.pool.query('SELECT 1 FROM users WHERE is_super_admin LIMIT 1');
    return !result.rowCount;
  }

  async setupFirstAdmin(username: string, password: string): Promise<string> {
    if (process.env.NODE_ENV === 'production' && process.env.SEPID_ALLOW_ADMIN_SETUP !== 'true') {
      throw new ForbiddenException('راه‌اندازی عمومی مدیر در این محیط غیرفعال است');
    }
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const existing = await client.query('SELECT 1 FROM users WHERE is_super_admin LIMIT 1');
      if (existing.rowCount) throw new ConflictException('مدیرکل سامانه از قبل ساخته شده است');
      const salt = randomBytes(16);
      const hash = await hashPassword(password, salt);
      const userId = randomUUID();
      await client.query(
        'INSERT INTO users(id, username, name, password_hash, is_super_admin) VALUES ($1, $2, $3, $4, true)',
        [userId, username, 'آرمین جمالی', `${salt.toString('hex')}:${hash.toString('hex')}`],
      );
      const token = randomBytes(32).toString('hex');
      await client.query(
        "INSERT INTO sessions(token_digest, user_id, expires_at) VALUES ($1, $2, now() + interval '8 hours')",
        [digest(token), userId],
      );
      await client.query('COMMIT');
      return token;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async current(request: RequestHeaders): Promise<Account> {
    const token = sessionToken(request);
    if (!token) throw new UnauthorizedException();
    const result = await this.database.pool.query<Account>(
      `SELECT u.id, u.name, u.is_super_admin, u.scope_shop FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_digest = $1 AND s.expires_at > now() AND u.active`,
      [digest(token)],
    );
    if (!result.rows[0]) throw new UnauthorizedException();
    return result.rows[0];
  }

  async permissions(account: Account): Promise<Record<string, number>> {
    if (account.is_super_admin) return { dashboard: 3, status: 3, repairs: 3, machines: 3, people: 3, settings: 3, maint: 3, parts: 3, analyses: 3, sms: 3 };
    const result = await this.database.pool.query<{ section: string; level: number }>(
      'SELECT section,level FROM user_section_permissions WHERE user_id=$1', [account.id],
    );
    return Object.fromEntries(result.rows.map(row => [row.section, row.level]));
  }

  async stagePermissions(account: Account): Promise<string[]> {
    if (account.is_super_admin) return (await configuredStages(this.database.pool)).map(stage=>stage.id);
    const result=await this.database.pool.query<{stage:string}>('SELECT stage FROM user_stage_permissions WHERE user_id=$1',[account.id]);
    return result.rows.map(row=>row.stage);
  }

  async access(request: RequestHeaders, section: 'machines' | 'people' | 'settings' | 'repairs' | 'status' | 'maint' | 'parts' | 'dashboard' | 'analyses' | 'sms', level: number): Promise<Account> {
    const account = await this.current(request);
    if (account.is_super_admin) return account;
    const result = await this.database.pool.query<{ level: number }>(
      'SELECT level FROM user_section_permissions WHERE user_id = $1 AND section = $2',
      [account.id, section],
    );
    if ((result.rows[0]?.level ?? 0) < level) throw new ForbiddenException();
    return account;
  }

  async requireStage(account: Account, stage: string) {
    if (account.is_super_admin) return;
    const result = await this.database.pool.query(
      'SELECT 1 FROM user_stage_permissions WHERE user_id = $1 AND stage = $2',
      [account.id, stage],
    );
    if (!result.rowCount) throw new ForbiddenException();
  }
}

@Controller('auth')
class AuthController {
  constructor(private readonly auth: Auth) {}

  @Get('setup-status')
  @Header('Cache-Control', 'no-store')
  async setupStatus() {
    return { required: await this.auth.setupRequired() };
  }

  @Get('otp-status')
  @Header('Cache-Control','no-store')
  async otpStatus(){return {enabled:await this.auth.otpAvailable()};}

  @Post('otp/request')
  @Header('Cache-Control','no-store')
  async requestOtp(@Req() request:RequestHeaders&{socket:{remoteAddress?:string}},@Body() body?:MachineInput){
    requireMutationHeader(request);
    const phone=normalizedSmsPhone(inputText(body?.phone,30,true));
    if(!/^09\d{9}$/.test(phone))throw new BadRequestException('شماره موبایل معتبر وارد کنید.');
    await this.auth.requestLoginCode(phone,request.socket.remoteAddress??'');
    return {accepted:true};
  }

  @Post('otp/verify')
  @Header('Cache-Control','no-store')
  async verifyOtp(@Req() request:RequestHeaders,@Res({passthrough:true}) response:ResponseHeaders,@Body() body?:MachineInput){
    requireMutationHeader(request);
    const phone=inputText(body?.phone,30,true);const code=inputText(body?.code,6,true);
    const token=await this.auth.verifyLoginCode(phone,code);
    await this.auth.logout(request);
    response.setHeader('Set-Cookie',sessionCookie(token,body?.remember===true?sessionSeconds:undefined));
    return {signedIn:true};
  }

  @Post('setup')
  @Header('Cache-Control', 'no-store')
  async setup(
    @Req() request: RequestHeaders,
    @Res({ passthrough: true }) response: ResponseHeaders,
    @Body() body: { username?: unknown; password?: unknown; confirmPassword?: unknown } | undefined,
  ) {
    requireMutationHeader(request);
    const username = inputText(body?.username, 100, true);
    const password = body?.password;
    if (!/^[a-zA-Z0-9._-]{3,100}$/.test(username) || typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new BadRequestException('نام کاربری معتبر و رمز عبور ۱۲ تا ۲۵۶ نویسه‌ای وارد کنید');
    }
    if (body?.confirmPassword !== password) throw new BadRequestException('تکرار رمز عبور یکسان نیست');
    const token = await this.auth.setupFirstAdmin(username, password);
    response.setHeader('Set-Cookie', sessionCookie(token, sessionSeconds));
    return { signedIn: true };
  }

  @Post('login')
  @Header('Cache-Control', 'no-store')
  async login(
    @Req() request: RequestHeaders & { socket: { remoteAddress?: string } },
    @Res({ passthrough: true }) response: ResponseHeaders,
    @Body() body: { username?: unknown; password?: unknown; remember?: unknown } | undefined,
  ) {
    requireMutationHeader(request);
    const username = inputText(body?.username, 100, true);
    const password = body?.password;
    if (typeof password !== 'string' || !password || password.length > 256) throw new BadRequestException();
    const token = await this.auth.login(username, password, request.socket.remoteAddress ?? '');
    await this.auth.logout(request);
    response.setHeader('Set-Cookie', sessionCookie(token, body?.remember === true ? sessionSeconds : undefined));
    return { signedIn: true };
  }

  @Post('logout')
  @Header('Cache-Control', 'no-store')
  async logout(@Req() request: RequestHeaders, @Res({ passthrough: true }) response: ResponseHeaders) {
    requireMutationHeader(request);
    await this.auth.logout(request);
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    return { signedIn: false };
  }

  @Post('password')
  @Header('Cache-Control', 'no-store')
  async changePassword(
    @Req() request: RequestHeaders,
    @Body() body: { currentPassword?: unknown; password?: unknown; confirmPassword?: unknown } | undefined,
  ) {
    requireMutationHeader(request);
    const currentPassword = body?.currentPassword;
    const password = body?.password;
    if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 256
      || typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new BadRequestException('رمز فعلی و رمز جدید ۱۲ تا ۲۵۶ نویسه‌ای لازم است');
    }
    if (body?.confirmPassword !== password) throw new BadRequestException('تکرار رمز عبور یکسان نیست');
    await this.auth.changePassword(request, currentPassword, password);
    return { changed: true };
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  async me(@Req() request: RequestHeaders) {
    const account = await this.auth.current(request);
    return { ...account, permissions: await this.auth.permissions(account), stages: await this.auth.stagePermissions(account) };
  }
}

type MachineInput = Record<string, unknown>;
const permissionLimits: Record<string, number> = {
  dashboard: 1, status: 3, repairs: 3, machines: 3, people: 3, settings: 2, maint: 3, parts: 3, analyses: 3, sms: 2,
};
type StageDefinition = { id: string; label: string; kind: 'report' | 'step' | 'test'; mode: 'report' | 'step' | 'wait' | 'done' | 'test'; loc: 'factory' | 'road' | 'shop' | 'part' | 'done'; limit: number | null; who: string; desc: string };
const defaultStages: StageDefinition[] = [
  { id: 'report', label: 'اعلام خرابی', kind: 'report', mode: 'report', loc: 'factory', limit: null, who: 'سرپرست', desc: 'خرابی ثبت شده و ماشین هنوز در کارخانه است' },
  { id: 'dispatch', label: 'اعزام به تعمیرگاه', kind: 'step', mode: 'step', loc: 'road', limit: null, who: 'تعمیرات', desc: 'ماشین به تعمیرگاه اعزام شده است' },
  { id: 'wait', label: 'در انتظار قطعه یا خدمات', kind: 'step', mode: 'wait', loc: 'part', limit: 7, who: 'تعمیرات', desc: 'ماشین برای تعمیر رفته و در انتظار تأمین قطعه یا انجام خدمات تعمیر است' },
  { id: 'done', label: 'پایان تعمیر', kind: 'step', mode: 'done', loc: 'shop', limit: 2, who: 'تعمیرات', desc: 'تعمیر تمام شده و ماشین باید در کارخانه تست سلامت شود' },
  { id: 'test', label: 'تست سلامت (ماشین در کارخانه)', kind: 'test', mode: 'test', loc: 'done', limit: null, who: 'سرپرست', desc: 'ماشین در کارخانه آزمایش می‌شود؛ اگر قبول شود پرونده بایگانی می‌شود و اگر رد شود خرابی جدید ثبت می‌شود' },
];

async function configuredStages(pool: Pool): Promise<StageDefinition[]> {
  const result = await pool.query<{ stages: StageDefinition[] | null }>("SELECT payload->'stages' AS stages FROM app_settings WHERE singleton");
  const stages = result.rows[0]?.stages;
  if (!Array.isArray(stages) || stages.length < 2) return defaultStages;
  return stages.map(stage => {
    const defaults=defaultStages.find(item=>item.id===stage.id);
    const mode=stage.mode??defaults?.mode??(stage.id==='report'?'report':stage.id==='test'?'test':stage.id==='wait'?'wait':stage.id==='done'?'done':'step');
    const defaultLoc=defaults?.loc??(mode==='report'?'factory':mode==='wait'?'part':mode==='done'?'shop':mode==='test'?'done':'shop');
    const label=stage.id==='report'&&stage.label==='اعلام خرابی (ماشین در کارخانه)'?'اعلام خرابی':stage.label??defaults?.label;
    return { ...defaults, ...stage, label, kind:stage.kind??defaults?.kind, mode, loc:stage.loc??defaultLoc, who:stage.who||defaults?.who||'', desc:stage.desc||defaults?.desc||'', limit: stage.limit === undefined ? (defaults?.limit??null) : stage.limit };
  });
}

type SmsStageRule={on:boolean;to:string[];text:string;pattern:{templateId:number|null;ippanelCode:string;bindings:Record<string,string>}|null};
const smsRecipientKeys=['supervisor','pm','admin'] as const;
const defaultSmsStageRules:Record<string,SmsStageRule>={
  report:{on:false,to:['supervisor'],text:'سامانه ناوگان: برای «ماشین» خرابی اعلام شد: «خرابی». ثبت: «ثبت‌کننده»',pattern:null},
  wait:{on:true,to:['supervisor'],text:'سامانه ناوگان: «ماشین» در مرحله «مرحله» است.[ «تعمیرگاه».][ منتظر: «قطعه».][ تحویل تقریبی «تحویل قطعه».] ثبت: «ثبت‌کننده»',pattern:null},
  done:{on:true,to:['supervisor'],text:'سامانه ناوگان: تعمیر «ماشین» به پایان رسید و آمادهٔ تست سلامت است.[ «توضیح»] ثبت: «ثبت‌کننده»',pattern:null},
  test:{on:true,to:['supervisor'],text:'سامانه ناوگان: تست سلامت «ماشین» ثبت شد. نتیجه: «نتیجه تست».[ «توضیح»] ثبت: «ثبت‌کننده»',pattern:null},
  step:{on:false,to:['supervisor'],text:'سامانه ناوگان: «ماشین» وارد مرحله «مرحله» شد.[ «توضیح»] ثبت: «ثبت‌کننده»',pattern:null},
};
function smsPatternFor(value:unknown):SmsStageRule['pattern']{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const candidate=value as Record<string,unknown>;const raw=candidate.bindings;
  const templateId=Number.isSafeInteger(candidate.templateId)&&Number(candidate.templateId)>0?Number(candidate.templateId):null;
  const ippanelCode=typeof candidate.ippanelCode==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(candidate.ippanelCode)?candidate.ippanelCode:'';
  if((!templateId&&!ippanelCode)||!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const allowed=['ماشین','پلاک','خرابی','مرحله','تاریخ','ساعت','ثبت‌کننده','تعمیرگاه','قطعه','تحویل قطعه','نتیجه تست','توضیح'];
  const entries=Object.entries(raw as Record<string,unknown>);
  if(entries.length>10||entries.some(([name,key])=>! /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)||typeof key!=='string'||!allowed.includes(key)))return null;
  return {templateId,ippanelCode,bindings:Object.fromEntries(entries) as Record<string,string>};
}
function smsRuleFor(rules:unknown,stage:StageDefinition):SmsStageRule{
  const configured=rules&&typeof rules==='object'&&!Array.isArray(rules)?rules as Record<string,unknown>:{};
  const value=configured[stage.id]??configured[stage.kind];
  const base=defaultSmsStageRules[stage.id]??defaultSmsStageRules[stage.kind]??defaultSmsStageRules.step;
  if(!value||typeof value!=='object'||Array.isArray(value))return base;
  const rule=value as Record<string,unknown>;
  return {on:typeof rule.on==='boolean'?rule.on:base.on,
    to:Array.isArray(rule.to)?[...new Set(rule.to.flatMap(item=>item==='sup'?['supervisor']:typeof item==='string'&&(smsRecipientKeys as readonly string[]).includes(item)?[item]:[]))]:base.to,
    text:typeof rule.text==='string'&&rule.text.trim()?rule.text.trim():base.text,
    pattern:smsPatternFor(rule.pattern)??base.pattern};
}
function renderSmsTemplate(template:string,variables:Record<string,string>):string{
  const fill=(value:string)=>value.replace(/«([^»]+)»/g,(_match,key:string)=>variables[key]??'');
  return fill(template.replace(/\[([^\[\]]*)\]/g,(_match,segment:string)=>{
    const keys=[...segment.matchAll(/«([^»]+)»/g)].map(match=>match[1]);
    return keys.some(key=>!(variables[key]??'').trim())?'':fill(segment);
  })).replace(/[ \t]+/g,' ').replace(/ ([.،:])/g,'$1').trim();
}
function normalizedSmsPhone(value:string):string{
  let digits=value.replace(/[۰-۹٠-٩]/g,char=>String('۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩'.indexOf(char)%10)).replace(/[^\d+]/g,'');
  if(digits.startsWith('+98'))digits=`0${digits.slice(3)}`;
  else if(digits.startsWith('0098'))digits=`0${digits.slice(4)}`;
  else if(digits.startsWith('98')&&digits.length===12)digits=`0${digits.slice(2)}`;
  else if(digits&&!digits.startsWith('0'))digits=`0${digits}`;
  return digits.replace(/\D/g,'');
}

@Controller('users')
class UsersController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  private async requireAdmin(request: RequestHeaders) {
    if (!(await this.auth.current(request)).is_super_admin) throw new ForbiddenException();
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: RequestHeaders) {
    await this.requireAdmin(request);
    const result = await this.database.pool.query(
      `SELECT u.id, u.name, u.username, u.active, u.is_super_admin,u.phone,u.receive_sms,u.scope_shop,u.person_id,u.last_login,
       coalesce((SELECT jsonb_object_agg(section, level) FROM user_section_permissions WHERE user_id=u.id),'{}') AS permissions,
       ARRAY(SELECT stage FROM user_stage_permissions WHERE user_id=u.id ORDER BY stage) AS stages
       FROM users u ORDER BY u.is_super_admin DESC, u.name, u.id`,
    );
    return result.rows;
  }

  @Post()
  async create(@Req() request: RequestHeaders, @Body() body?: MachineInput) {
    return this.save(request, body);
  }

  @Patch(':id')
  async edit(@Req() request: RequestHeaders, @Param('id') id: string, @Body() body?: MachineInput) {
    return this.save(request, body, id);
  }

  private async save(request: RequestHeaders, body?: MachineInput, existingId?: string) {
    requireMutationHeader(request);
    await this.requireAdmin(request);
    const username = inputText(body?.username, 100, true);
    const name = inputText(body?.name, 150, true);
    const active = body?.active;
    const password = body?.password;
    const rawPhone = inputText(body?.phone ?? '', 30);
    const phone = rawPhone ? normalizedSmsPhone(rawPhone) : '';
    const personId = inputText(body?.person_id ?? '', 150) || null;
    const receiveSms = body?.receive_sms === true;
    const scopeShop = body?.scope_shop === true;
    const permissions = body?.permissions;
    const stages = body?.stages;
    if (!/^[a-zA-Z0-9._-]{3,100}$/.test(username)) {
      throw new BadRequestException('نام کاربری باید ۳ تا ۱۰۰ نویسه و شامل حروف انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد.');
    }
    if (typeof password !== 'string' || password.length > 256 ||
        ((!existingId || password.length > 0) && password.length < 12)) {
      throw new BadRequestException('رمز عبور جدید باید ۱۲ تا ۲۵۶ نویسه داشته باشد.');
    }
    if (rawPhone !== '' && !/^09\d{9}$/.test(phone)) {
      throw new BadRequestException('شمارهٔ موبایل معتبر ایران وارد کنید.');
    }
    if (typeof active !== 'boolean'
      || !permissions || typeof permissions !== 'object' || Array.isArray(permissions)
      || (body?.receive_sms !== undefined && typeof body.receive_sms !== 'boolean')
      || (personId !== null && !(await this.database.pool.query('SELECT 1 FROM people WHERE id=$1', [personId])).rowCount)
      || (body?.scope_shop !== undefined && typeof body.scope_shop !== 'boolean')
      || (receiveSms && !phone) || !Array.isArray(stages)) {
      throw new BadRequestException('Invalid account details');
    }
    const stageIds = new Set((await configuredStages(this.database.pool)).map(stage => stage.id));
    if (!stages.every(stage => typeof stage === 'string' && stageIds.has(stage))) {
      throw new BadRequestException('یکی از مراحل انتخاب‌شده دیگر در تنظیمات وجود ندارد. صفحه را تازه‌سازی کنید.');
    }
    const levels = Object.entries(permissions);
    for (const [section, level] of levels) {
      if (!Object.hasOwn(permissionLimits, section) || typeof level !== 'number'
        || !Number.isInteger(level) || level < 0 || level > permissionLimits[section]) throw new BadRequestException();
    }
    let encoded = null;
    if (password) {
      const salt = randomBytes(16);
      encoded = salt.toString('hex') + ':' + (await hashPassword(password, salt)).toString('hex');
    }
    const id = existingId ?? randomUUID();
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      if (existingId) {
        const result = await client.query(
          `UPDATE users SET name=$2,username=$3,active=$4,password_hash=coalesce($5,password_hash),phone=$6,receive_sms=$7,scope_shop=$8,person_id=$9
           WHERE id=$1 AND NOT is_super_admin`, [id, name, username, active, encoded, phone, receiveSms, scopeShop, personId],
        );
        if (!result.rowCount) throw new NotFoundException();
      } else {
        await client.query('INSERT INTO users(id,name,username,active,password_hash,phone,receive_sms,scope_shop,person_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [id, name, username, active, encoded, phone, receiveSms, scopeShop, personId]);
      }
      await client.query('DELETE FROM user_section_permissions WHERE user_id=$1', [id]);
      await client.query('DELETE FROM user_stage_permissions WHERE user_id=$1', [id]);
      for (const [section, level] of levels) {
        if (level) await client.query('INSERT INTO user_section_permissions VALUES($1,$2,$3)', [id, section, level]);
      }
      for (const stage of new Set(stages)) {
        await client.query('INSERT INTO user_stage_permissions VALUES($1,$2)', [id, stage]);
      }
      if (!active || encoded) await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await client.query('COMMIT');
      return { id };
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Username already exists');
      throw error;
    } finally {
      client.release();
    }
  }
}
const machineColumns = 'id, code, plate, type, unit, note, active, version, model_id, driver_id, supervisor_id, pm_id, floating_driver';

function machineFields(body: MachineInput | undefined) {
  const unit = body?.unit;
  if (unit !== 'km' && unit !== 'hour') throw new BadRequestException('Invalid unit');
  if (typeof body?.active !== 'boolean') throw new BadRequestException('Invalid status');
  if (body?.floating_driver !== undefined && typeof body.floating_driver !== 'boolean') throw new BadRequestException('Invalid driver assignment');
  const floatingDriver = body?.floating_driver === true;
  return [
    inputText(body.code, 100, true), inputText(body.plate, 100),
    inputText(body.type, 100), unit, inputText(body.note, 4000), body.active,
    ...['model_id', 'driver_id', 'supervisor_id', 'pm_id'].map(key => {
      const value = body[key];
      if (key === 'driver_id' && floatingDriver) return null;
      return value == null || value === '' ? null : inputText(value, 100, true);
    }),
    floatingDriver,
  ];
}

@Controller('machines')
class MachinesController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  private async validateAssignments(fields: ReturnType<typeof machineFields>) {
    const [model, driver, supervisor, pm] = fields.slice(6, 10);
    const result = await this.database.pool.query<{ valid: boolean }>(
      `SELECT
        ($1::text IS NULL OR EXISTS (SELECT 1 FROM machine_models WHERE id = $1))
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM people WHERE id = $2 AND role = 'driver'))
        AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM people WHERE id = $3 AND role = 'supervisor'))
        AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM people WHERE id = $4 AND role = 'pm')) AS valid`,
      [model, driver, supervisor, pm],
    );
    if (!result.rows[0].valid) throw new BadRequestException('Invalid machine assignment');
  }

  @Get('options')
  @Header('Cache-Control', 'no-store')
  async options(@Req() request: RequestHeaders) {
    await this.auth.access(request, 'machines', 1);
    const [models, people] = await Promise.all([
      this.database.pool.query('SELECT id, name, brand, version FROM machine_models ORDER BY name, id'),
      this.database.pool.query('SELECT id, name, role, active, version FROM people ORDER BY name, id'),
    ]);
    return { models: models.rows, people: people.rows };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: RequestHeaders) {
    await this.auth.access(request, 'machines', 1);
    const result = await this.database.pool.query(
      `SELECT ${machineColumns} FROM machines ORDER BY sort_order, id`,
    );
    return result.rows;
  }

  @Post()
  async create(@Req() request: RequestHeaders, @Body() body: MachineInput | undefined) {
    requireMutationHeader(request);
    await this.auth.access(request, 'machines', 2);
    const fields = machineFields(body);
    await this.validateAssignments(fields);
    const result = await this.database.pool.query(
      `INSERT INTO machines (id, code, plate, type, unit, note, active, model_id, driver_id, supervisor_id, pm_id, floating_driver)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${machineColumns}`,
      [randomUUID(), ...fields],
    );
    return result.rows[0];
  }

  @Patch(':id')
  async update(@Req() request: RequestHeaders, @Param('id') id: string, @Body() body: MachineInput | undefined) {
    requireMutationHeader(request);
    await this.auth.access(request, 'machines', 2);
    const fields = machineFields(body);
    const version = body?.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 2147483647) {
      throw new BadRequestException('Invalid version');
    }
    await this.validateAssignments(fields);
    const result = await this.database.pool.query(
      `UPDATE machines SET code=$1, plate=$2, type=$3, unit=$4, note=$5, active=$6,
       model_id=$7, driver_id=$8, supervisor_id=$9, pm_id=$10, floating_driver=$11, version=version+1
       WHERE id=$12 AND version=$13 RETURNING ${machineColumns}`,
      [...fields, id, version],
    );
    if (result.rowCount) return result.rows[0];
    const exists = await this.database.pool.query('SELECT 1 FROM machines WHERE id=$1', [id]);
    if (!exists.rowCount) throw new NotFoundException();
    throw new ConflictException('The record changed. Reload before editing.');
  }
}

@Controller()
class DirectoryController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  @Get('people')
  @Header('Cache-Control', 'no-store')
  async listPeople(@Req() request: RequestHeaders) {
    const account = await this.auth.access(request, 'people', 1);
    const permissions = await this.auth.permissions(account);
    const detailed = (permissions.people ?? 0) >= 2;
    const result = await this.database.pool.query(
      detailed
        ? `SELECT p.id,p.name,p.role,p.phone,p.note,p.active,p.version,
             COALESCE((SELECT json_agg(m.code ORDER BY m.sort_order,m.id) FROM machines m WHERE m.active AND p.id IN (m.driver_id,m.supervisor_id,m.pm_id)),'[]'::json) AS machine_codes
           FROM people p ORDER BY p.name,p.id`
        : `SELECT p.id,p.name,p.role,p.active,
             COALESCE((SELECT json_agg(m.code ORDER BY m.sort_order,m.id) FROM machines m WHERE m.active AND p.id IN (m.driver_id,m.supervisor_id,m.pm_id)),'[]'::json) AS machine_codes
           FROM people p ORDER BY p.name,p.id`,
    );
    return result.rows;
  }

  @Post('models')
  async model(@Req() request: RequestHeaders, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    await this.auth.access(request, 'settings', 2);
    const result = await this.database.pool.query(
      'INSERT INTO machine_models (id, name, brand) VALUES ($1,$2,$3) RETURNING id, name, brand',
      [randomUUID(), inputText(body?.name, 150, true), inputText(body?.brand, 100)],
    );
    return result.rows[0];
  }

  @Patch('models/:id')
  async updateModel(@Req() request: RequestHeaders, @Param('id') id: string, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    await this.auth.access(request, 'settings', 2);
    if (!Number.isInteger(body?.version) || Number(body?.version) < 1) throw new BadRequestException();
    const result = await this.database.pool.query(
      'UPDATE machine_models SET name=$3,brand=$4,version=version+1 WHERE id=$1 AND version=$2 RETURNING id,name,brand,version',
      [id,Number(body?.version),inputText(body?.name,150,true),inputText(body?.brand,100)],
    );
    if (result.rowCount) return result.rows[0];
    const exists = await this.database.pool.query('SELECT 1 FROM machine_models WHERE id=$1', [id]);
    if (!exists.rowCount) throw new NotFoundException();
    throw new ConflictException();
  }

  @Delete('models/:id')
  async deleteModel(@Req() request: RequestHeaders, @Param('id') id: string) {
    requireMutationHeader(request);
    await this.auth.access(request, 'settings', 2);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const model = await client.query('SELECT id FROM machine_models WHERE id=$1 FOR UPDATE', [id]);
      if (!model.rowCount) throw new NotFoundException();
      const assigned = await client.query('SELECT 1 FROM machines WHERE model_id=$1 LIMIT 1', [id]);
      if (assigned.rowCount) throw new ConflictException('این مدل به یک یا چند ماشین اختصاص دارد و قابل حذف نیست.');
      await client.query('DELETE FROM part_alternatives a USING model_parts p WHERE a.part_id=p.id AND p.model_id=$1', [id]);
      await client.query('DELETE FROM model_parts WHERE model_id=$1', [id]);
      await client.query('DELETE FROM machine_models WHERE id=$1', [id]);
      await client.query('COMMIT');
      return { id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('people')
  async person(@Req() request: RequestHeaders, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    await this.auth.access(request, 'people', 2);
    const role = body?.role;
    if (role !== 'driver' && role !== 'supervisor' && role !== 'pm' && role !== 'other') throw new BadRequestException('Invalid role');
    const result = await this.database.pool.query(
      'INSERT INTO people (id, name, role, phone, note) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, role, active',
      [randomUUID(), inputText(body?.name, 150, true), role, inputText(body?.phone, 40), inputText(body?.note, 4000)],
    );
    return result.rows[0];
  }

  @Patch('people/:id')
  async updatePerson(@Req() request: RequestHeaders, @Param('id') id: string, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    await this.auth.access(request, 'people', 2);
    if (!Number.isInteger(body?.version) || Number(body?.version) < 1 || typeof body?.active !== 'boolean') throw new BadRequestException();
    const result = await this.database.pool.query(
      'UPDATE people SET name=$3,phone=$4,note=$5,active=$6,version=version+1 WHERE id=$1 AND version=$2 RETURNING id,name,role,phone,note,active,version',
      [id,Number(body.version),inputText(body?.name,150,true),inputText(body?.phone,40),inputText(body?.note,4000),body.active],
    );
    if (result.rowCount) return result.rows[0];
    const exists = await this.database.pool.query('SELECT 1 FROM people WHERE id=$1', [id]);
    if (!exists.rowCount) throw new NotFoundException();
    throw new ConflictException();
  }
}

@Controller('repairs')
class RepairsController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  @Delete(':id')
  async remove(@Req() request: RequestHeaders, @Param('id', ParseUUIDPipe) id: string, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'repairs', 3);
    if (account.scope_shop) throw new ForbiddenException();
    if (typeof body?.version !== 'number' || !Number.isInteger(body.version)) throw new BadRequestException();
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const repair = await client.query('SELECT version FROM repairs WHERE id=$1 FOR UPDATE', [id]);
      if (!repair.rowCount) throw new NotFoundException('پرونده پیدا نشد.');
      if (repair.rows[0].version !== body.version) throw new ConflictException('پرونده تغییر کرده است. فهرست را تازه‌سازی کنید.');
      const followUp = await client.query('SELECT 1 FROM repairs WHERE previous_repair_id=$1 LIMIT 1', [id]);
      if (followUp.rowCount) throw new ConflictException('این پرونده پروندهٔ پیگیری دارد. ابتدا پروندهٔ پیگیری را بررسی کنید.');
      await client.query('DELETE FROM repair_events WHERE repair_id=$1', [id]);
      await client.query('DELETE FROM repairs WHERE id=$1', [id]);
      await client.query('COMMIT');
      return { deleted: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Get('stages')
  @Header('Cache-Control', 'no-store')
  async stages(@Req() request: RequestHeaders) {
    await this.auth.access(request, 'repairs', 1);
    return configuredStages(this.database.pool);
  }

  @Get('machines')
  @Header('Cache-Control', 'no-store')
  async machineOptions(@Req() request: RequestHeaders) {
    await this.auth.access(request, 'repairs', 2);
    const result = await this.database.pool.query(`SELECT m.id,m.code,m.active,m.type,model.name AS model_name
      FROM machines m LEFT JOIN machine_models model ON model.id=m.model_id ORDER BY m.sort_order,m.id`);
    return result.rows;
  }

  @Get('diagnosers')
  @Header('Cache-Control', 'no-store')
  async diagnoserOptions(@Req() request: RequestHeaders) {
    await this.auth.access(request, 'repairs', 2);
    const result = await this.database.pool.query<{ name: string }>(`SELECT name FROM (
        SELECT name FROM people WHERE active AND role IN ('pm','supervisor')
        UNION SELECT diagnoser AS name FROM repairs WHERE btrim(diagnoser) <> ''
      ) names ORDER BY name`);
    return result.rows.map(row => row.name);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: RequestHeaders) {
    const account=await this.auth.access(request, 'repairs', 1);
    const steps=account.scope_shop?(await configuredStages(this.database.pool)).filter(stage=>stage.kind==='step').map(stage=>stage.id):null;
    const result = await this.database.pool.query(
      `SELECT r.id,r.number,r.machine_id,r.previous_repair_id,previous.number AS previous_repair_number,r.title,r.urgency,r.shop,r.note,r.stage,r.result,r.version,r.created_at,r.updated_at,r.workflow,
        r.report_date::text AS report_date,r.diagnoser,r.expected_date::text AS expected_date,r.refer_date::text AS refer_date,
        r.repairer_note,r.return_date::text AS return_date,r.delay_reason,m.code AS machine_code,
        (SELECT e.recorded_at::date::text FROM repair_events e WHERE e.repair_id=r.id AND e.stage=r.workflow[cardinality(r.workflow)-1] AND e.result IS NULL AND e.voided_at IS NULL ORDER BY e.revision DESC LIMIT 1) AS repair_completed_date,
        (SELECT e.recorded_at::date::text FROM repair_events e WHERE e.repair_id=r.id AND e.stage=r.workflow[cardinality(r.workflow)] AND e.result IS NOT NULL AND e.voided_at IS NULL ORDER BY e.revision DESC LIMIT 1) AS test_completed_date,
        (SELECT e.note FROM repair_events e WHERE e.repair_id=r.id AND e.stage=r.workflow[cardinality(r.workflow)] AND e.result IS NOT NULL AND e.voided_at IS NULL ORDER BY e.revision DESC LIMIT 1) AS test_note,
        (SELECT max(e.recorded_at) FROM repair_events e WHERE e.repair_id=r.id AND e.stage=r.stage AND e.voided_at IS NULL) AS current_stage_since
       FROM repairs r JOIN machines m ON m.id = r.machine_id LEFT JOIN repairs previous ON previous.id=r.previous_repair_id
       WHERE $1::text[] IS NULL OR r.stage=ANY($1::text[])
       ORDER BY r.number DESC`,
      [steps],
    );
    return result.rows;
  }

  @Get('machines/:machineId/history')
  @Header('Cache-Control', 'no-store')
  async machineHistory(@Req() request: RequestHeaders, @Param('machineId') machineId: string) {
    const account=await this.auth.access(request,'repairs',1);
    const stages=await configuredStages(this.database.pool);
    const visibleStages=account.scope_shop?stages.filter(stage=>stage.kind==='step').map(stage=>stage.id):null;
    const events=await this.database.pool.query(`SELECT e.id,e.repair_id,e.revision,e.stage,e.result,e.note,e.details,e.voided_at,e.recorded_at::text AS recorded_at,
        r.number,r.title,r.shop,u.name AS actor_name
      FROM repairs r JOIN repair_events e ON e.repair_id=r.id JOIN users u ON u.id=e.actor_id
      WHERE r.machine_id=$1 AND ($2::text[] IS NULL OR r.stage=ANY($2::text[]))
      ORDER BY e.recorded_at DESC,e.revision DESC LIMIT 500`,[inputText(machineId,100,true),visibleStages]);
    const stageMap=new Map(stages.map(stage=>[stage.id,stage]));
    return events.rows.map(event=>{
      const stage=stageMap.get(event.stage);
      const label=stage?.label??event.stage;
      return {...event,stage_label:stage?.kind==='test'&&event.result?`${label} · ${event.result==='pass'?'قبول':event.result==='fail'?'رد':'پیش از ثبت تست'}`:label};
    });
  }

  @Post()
  async create(@Req() request: RequestHeaders, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'repairs', 2);
    await this.auth.requireStage(account, 'report');
    const workflow = (await configuredStages(this.database.pool)).map(stage => stage.id);
    const urgency = body?.urgency;
    if (urgency !== 'urgent' && urgency !== 'd13' && urgency !== 'd47' && urgency !== 'none') {
      throw new BadRequestException('Invalid urgency');
    }
    const reportDate = body?.report_date === undefined ? null : calendarDate(body.report_date);
    const expectedDate = body?.expected_date ? calendarDate(body.expected_date) : null;
    if (reportDate && expectedDate && expectedDate < reportDate) throw new BadRequestException('Expected date precedes report date');
    const previousRepairId=body?.previous_repair_id??null;
    if(previousRepairId!==null){
      if(typeof previousRepairId!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(previousRepairId))throw new BadRequestException('Invalid previous repair');
      const previous=await this.database.pool.query(`SELECT 1 FROM repairs r WHERE r.id=$1 AND r.machine_id=$2 AND r.result='fail'
        AND NOT EXISTS(SELECT 1 FROM repairs child WHERE child.previous_repair_id=r.id)`, [previousRepairId,inputText(body?.machine_id,100,true)]);
      if(!previous.rowCount)throw new BadRequestException('A follow-up must refer to a rejected test for the same machine and may be used once');
    }
    const result = await this.database.pool.query(
      `WITH created AS (
         INSERT INTO repairs (id, machine_id, title, urgency, shop, note, report_date, diagnoser, expected_date, repairer_note, delay_reason, workflow, previous_repair_id)
         SELECT $1, m.id, $3, $4, $5, $6, COALESCE($7::date,(now() AT TIME ZONE 'Asia/Tehran')::date), $8, $9::date, $10, $11, $14, $15
         FROM machines m WHERE m.id = $2 AND m.active
         RETURNING *
       ), event AS (
         INSERT INTO repair_events (id, repair_id, revision, stage, note, actor_id)
         SELECT $13, id, version, stage, title, $12 FROM created
       )
       SELECT created.id,created.number,created.machine_id,created.previous_repair_id,previous.number AS previous_repair_number,created.title,created.urgency,created.shop,created.note,created.stage,created.result,
         created.version,created.workflow,created.created_at,created.updated_at,created.report_date::text AS report_date,created.diagnoser,
         created.expected_date::text AS expected_date,created.refer_date::text AS refer_date,created.repairer_note,
         created.return_date::text AS return_date,created.delay_reason,m.code AS machine_code
       FROM created JOIN machines m ON m.id = created.machine_id LEFT JOIN repairs previous ON previous.id=created.previous_repair_id`,
      [randomUUID(), inputText(body?.machine_id, 100, true), inputText(body?.title, 200, true),
        urgency, inputText(body?.shop ?? '', 150), inputText(body?.note ?? '', 4000), reportDate,
        inputText(body?.diagnoser ?? '', 150), expectedDate, inputText(body?.repairer_note ?? '', 4000),
        inputText(body?.delay_reason ?? '', 4000), account.id, randomUUID(), workflow, previousRepairId],
    );
    if (!result.rowCount) throw new BadRequestException('Machine unavailable');
    return result.rows[0];
  }

  @Patch(':id')
  async update(@Req() request: RequestHeaders, @Param('id', ParseUUIDPipe) id: string, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'repairs', 2);
    await this.auth.requireStage(account, 'report');
    const version = body?.version;
    const urgency = body?.urgency;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version >= 2147483647
      || !['urgent','d13','d47','none'].includes(String(urgency))) throw new BadRequestException();
    const reportDate = calendarDate(body?.report_date);
    const expectedDate = body?.expected_date ? calendarDate(body.expected_date) : null;
    if (expectedDate && expectedDate < reportDate) throw new BadRequestException('Expected date precedes report date');
    let result;
    try { result = await this.database.pool.query(
      `WITH changed AS (
         UPDATE repairs r SET machine_id=m.id,title=$4,urgency=$5,shop=$6,note=$7,report_date=$8::date,diagnoser=$9,
           expected_date=$10::date,repairer_note=$11,delay_reason=$12,version=r.version+1,updated_at=now()
         FROM machines m WHERE r.id=$1 AND r.version=$2 AND m.id=$3 AND (m.active OR r.machine_id=m.id)
           AND (r.refer_date IS NULL OR $8::date<=r.refer_date)
           AND (r.return_date IS NULL OR r.refer_date IS NULL OR r.return_date>=r.refer_date)
           AND ($10::date IS NULL OR r.refer_date IS NULL OR $10::date>=r.refer_date)
         RETURNING r.*
       )
       SELECT changed.id,changed.number,changed.machine_id,changed.previous_repair_id,previous.number AS previous_repair_number,changed.title,changed.urgency,changed.shop,changed.note,changed.stage,changed.result,
         changed.version,changed.workflow,changed.created_at,changed.updated_at,changed.report_date::text AS report_date,changed.diagnoser,
         changed.expected_date::text AS expected_date,changed.refer_date::text AS refer_date,changed.repairer_note,
         changed.return_date::text AS return_date,changed.delay_reason,m.code AS machine_code
       FROM changed JOIN machines m ON m.id=changed.machine_id LEFT JOIN repairs previous ON previous.id=changed.previous_repair_id`,
      [id,version,inputText(body?.machine_id,100,true),inputText(body?.title,200,true),urgency,inputText(body?.shop,150),
        inputText(body?.note,4000),reportDate,inputText(body?.diagnoser,150),expectedDate,
        inputText(body?.repairer_note,4000),inputText(body?.delay_reason,4000)],
    ); } catch (error) {
      console.error('Repair update failed:', error instanceof Error ? error.message : 'unknown database error');
      throw error;
    }
    if (!result.rowCount) throw new ConflictException('Repair already changed or unavailable');
    return result.rows[0];
  }

  @Get(':id/events')
  @Header('Cache-Control', 'no-store')
  async history(@Req() request: RequestHeaders, @Param('id', ParseUUIDPipe) id: string) {
    const account=await this.auth.access(request, 'repairs', 1);
    const steps=account.scope_shop?(await configuredStages(this.database.pool)).filter(stage=>stage.kind==='step').map(stage=>stage.id):null;
    const result = await this.database.pool.query(
      `SELECT e.id, e.revision, e.stage, e.result, e.note, e.details, e.recorded_at, e.voided_at,
         vu.name AS voided_by_name, ((e.before_state ? 'stage') AND e.voided_at IS NULL) AS undoable, u.name AS actor_name
       FROM repair_events e JOIN users u ON u.id = e.actor_id
       LEFT JOIN users vu ON vu.id=e.voided_by
       JOIN repairs r ON r.id=e.repair_id WHERE e.repair_id = $1 AND ($2::text[] IS NULL OR r.stage=ANY($2::text[])) ORDER BY e.revision`,
      [id,steps],
    );
    if (!result.rowCount) throw new NotFoundException();
    return result.rows;
  }

  @Post(':id/events')
  async advance(
    @Req() request: RequestHeaders, @Param('id', ParseUUIDPipe) id: string, @Body() body?: MachineInput,
  ) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'status', 2);
    const previous = body?.previous;
    const version = body?.version;
    if (typeof previous !== 'string') throw new BadRequestException('Invalid previous stage');
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version >= 2147483647) {
      throw new BadRequestException('Invalid version');
    }
    const [stages, savedWorkflow] = await Promise.all([
      configuredStages(this.database.pool),
      this.database.pool.query<{ workflow: string[] }>('SELECT workflow FROM repairs WHERE id=$1', [id]),
    ]);
    const workflow = savedWorkflow.rows[0]?.workflow;
    if (!workflow) throw new ConflictException('Repair unavailable');
    const previousIndex = workflow.indexOf(previous);
    const repeatCurrent=body?.repeat_current===true||body?.repeat_current==='true';
    if (previousIndex < 0 || (repeatCurrent ? previousIndex <= 0 || previousIndex >= workflow.length-2 : previousIndex >= workflow.length - 1)) throw new BadRequestException('Invalid previous stage');
    if(repeatCurrent&&stages.find(item=>item.id===previous)?.kind!=='step')throw new BadRequestException('This stage cannot be updated in place');
    const nextId = repeatCurrent?previous:workflow[previousIndex + 1];
    const next = stages.find(item => item.id === nextId);
    if (!next) throw new ConflictException('Repair stage was removed from configuration');
    const stage = next.id;
    await this.auth.requireStage(account, stage);
    const outcome = body?.result ?? null;
    if (next.kind === 'test' ? outcome !== 'pass' && outcome !== 'fail' : outcome !== null) {
      throw new BadRequestException('Invalid test outcome');
    }
    const provider = selectedSmsProvider(await storedSmsIr(this.database.pool));
    const stageLabel = next.kind === 'test' ? `${next.label} ${outcome === 'pass' ? 'قبول شد' : 'رد شد'}` : next.label;
    const rawDetails:Record<string,unknown>={};
    if(body&&Object.hasOwn(body,'shop'))rawDetails.shop=inputText(body.shop,150);
    if(body&&Object.hasOwn(body,'expected_date'))rawDetails.expected_date=body.expected_date?calendarDate(body.expected_date):'';
    if (!repeatCurrent && previous === 'report' && stage === 'dispatch') {
      if (!body?.refer_date) throw new BadRequestException('تاریخ رفتن به تعمیرگاه الزامی است.');
      if (!rawDetails.shop) throw new BadRequestException('نام تعمیرکار الزامی است.');
      rawDetails.refer_date = calendarDate(body.refer_date);
    }
    if (!repeatCurrent && previous === 'dispatch' && next.mode === 'wait' && !rawDetails.expected_date) {
      throw new BadRequestException('تاریخ پیش‌بینی بازگشت از تعمیر الزامی است.');
    }
    if(body&&Object.hasOwn(body,'part_name'))rawDetails.part_name=inputText(body.part_name,200);
    if(body&&Object.hasOwn(body,'part_status')){
      if(!['ordered','bought','shipping','arrived'].includes(String(body.part_status)))throw new BadRequestException('Invalid part status');
      rawDetails.part_status=body.part_status;
    }
    if(body&&Object.hasOwn(body,'part_eta'))rawDetails.part_eta=body.part_eta?calendarDate(body.part_eta):'';
    if(body&&Object.hasOwn(body,'part_vendor'))rawDetails.part_vendor=inputText(body.part_vendor,200);
    if(body&&Object.hasOwn(body,'event_date')&&body.event_date)rawDetails.event_date=calendarDate(body.event_date);
    if(repeatCurrent)rawDetails.repeat_current='true';
    const eventDate=typeof rawDetails.event_date==='string'?rawDetails.event_date:null;
    const eventNote=inputText(body?.note??'',4000);
    let eventTime:string|null=null;
    if(body?.event_time!==undefined&&body.event_time!==''){
      if(typeof body.event_time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.event_time))throw new BadRequestException('Invalid event time');
      eventTime=body.event_time;rawDetails.event_time=eventTime;
    }
    const client=await this.database.pool.connect();
    try{
      await client.query('BEGIN');
      const current = await client.query('SELECT report_date::text,refer_date::text FROM repairs WHERE id=$1 AND version=$2 AND stage=$3 FOR UPDATE', [id, version, previous]);
      if (!current.rowCount) throw new ConflictException('Repair already changed or unavailable');
      if (typeof rawDetails.refer_date === 'string' && rawDetails.refer_date < current.rows[0].report_date) {
        throw new BadRequestException('تاریخ رفتن به تعمیرگاه نباید قبل از اعلام خرابی باشد.');
      }
      if (typeof rawDetails.expected_date === 'string' && rawDetails.expected_date &&
          rawDetails.expected_date < (current.rows[0].refer_date ?? current.rows[0].report_date)) {
        throw new BadRequestException('تاریخ پیش‌بینی بازگشت نباید قبل از اعزام به تعمیرگاه باشد.');
      }
      const smsSettings=await client.query("SELECT coalesce((payload->>'smsStageAlerts')::boolean,false) AS enabled,payload->'smsRules' AS rules FROM app_settings WHERE singleton");
      const smsRule=smsRuleFor(smsSettings.rows[0]?.rules,next);
      const result = await client.query(
      `WITH stage_args AS (SELECT $9::text AS stage_label,$10::text AS provider), prior AS MATERIALIZED (
         SELECT id,stage,result,refer_date,return_date,repairer_note,delay_reason,shop,expected_date
         FROM repairs WHERE id=$1 AND version=$2 AND stage=$3 FOR UPDATE
       ), changed AS (
         UPDATE repairs r SET stage = $4, result = $5, version = r.version + 1, updated_at = now(),
           refer_date = CASE WHEN $13 THEN COALESCE(($17::jsonb->>'refer_date')::date,r.refer_date,(now() AT TIME ZONE 'Asia/Tehran')::date) ELSE r.refer_date END,
           return_date = CASE WHEN $14 THEN COALESCE(r.return_date,(now() AT TIME ZONE 'Asia/Tehran')::date) ELSE r.return_date END,
           repairer_note = CASE WHEN $15 THEN $11 ELSE r.repairer_note END,
           delay_reason = CASE WHEN $16 THEN $12 ELSE r.delay_reason END,
           shop = CASE WHEN $17::jsonb ? 'shop' THEN $17::jsonb->>'shop' ELSE r.shop END,
           expected_date = CASE WHEN $17::jsonb ? 'expected_date' THEN NULLIF($17::jsonb->>'expected_date','')::date ELSE r.expected_date END
         FROM prior WHERE r.id = prior.id RETURNING r.*
       ), event AS (
         INSERT INTO repair_events (id, repair_id, revision, stage, result, note, actor_id, before_state,details,recorded_at)
         SELECT $6, changed.id, changed.version, changed.stage, changed.result, $7, $8,
           jsonb_build_object('stage',prior.stage,'result',prior.result,'refer_date',prior.refer_date,
             'return_date',prior.return_date,'repairer_note',prior.repairer_note,'delay_reason',prior.delay_reason,
             'shop',prior.shop,'expected_date',prior.expected_date),$17::jsonb,
           CASE WHEN $18::date IS NULL THEN now() ELSE (($18::date + COALESCE($19::time,localtime)) AT TIME ZONE 'Asia/Tehran') END
         FROM changed JOIN prior ON prior.id=changed.id
       )
       SELECT changed.id,changed.number,changed.machine_id,changed.previous_repair_id,previous.number AS previous_repair_number,changed.title,changed.urgency,changed.shop,changed.note,changed.stage,changed.result,
         changed.version,changed.workflow,changed.created_at,changed.updated_at,changed.report_date::text AS report_date,changed.diagnoser,
         changed.expected_date::text AS expected_date,changed.refer_date::text AS refer_date,changed.repairer_note,
         changed.return_date::text AS return_date,changed.delay_reason,m.code AS machine_code,m.plate
       FROM changed JOIN machines m ON m.id = changed.machine_id LEFT JOIN repairs previous ON previous.id=changed.previous_repair_id CROSS JOIN stage_args`,
      [id, version, previous, stage, outcome, randomUUID(), eventNote, account.id, stageLabel, provider,
        inputText(body?.repairer_note ?? '', 4000), inputText(body?.delay_reason ?? '', 4000),
        previous === 'report', next.kind === 'test', stage === 'done', next.kind === 'test',JSON.stringify(rawDetails),eventDate,eventTime],
    );
      if (!result.rowCount) throw new ConflictException('Repair already changed or unavailable');
      const repair=result.rows[0];
      if(smsSettings.rows[0]?.enabled&&smsRule.on){
        const targets=await client.query<{phone:string}>(`SELECT DISTINCT phone FROM (
          SELECT COALESCE(NULLIF(linked.phone,''),p.phone) AS phone FROM machines m JOIN people p ON p.id=m.supervisor_id
            LEFT JOIN LATERAL (SELECT u.phone FROM users u WHERE u.person_id=p.id AND u.active AND u.phone<>'' ORDER BY u.receive_sms DESC,u.id LIMIT 1) linked ON true
            WHERE m.id=$1 AND p.active AND COALESCE(NULLIF(linked.phone,''),p.phone)<>'' AND $2::text[] @> ARRAY['supervisor']::text[]
          UNION ALL SELECT COALESCE(NULLIF(linked.phone,''),p.phone) AS phone FROM machines m JOIN people p ON p.id=m.pm_id
            LEFT JOIN LATERAL (SELECT u.phone FROM users u WHERE u.person_id=p.id AND u.active AND u.phone<>'' ORDER BY u.receive_sms DESC,u.id LIMIT 1) linked ON true
            WHERE m.id=$1 AND p.active AND COALESCE(NULLIF(linked.phone,''),p.phone)<>'' AND $2::text[] @> ARRAY['pm']::text[]
          UNION ALL SELECT u.phone FROM users u WHERE u.active AND u.is_super_admin AND u.phone<>'' AND $2::text[] @> ARRAY['admin']::text[]
          UNION ALL SELECT u.phone FROM users u WHERE u.active AND u.receive_sms AND u.phone<>''
        ) recipients`,[repair.machine_id,smsRule.to]);
        const actor=await client.query<{phone:string}>('SELECT phone FROM users WHERE id=$1',[account.id]);
        const actorPhone=normalizedSmsPhone(actor.rows[0]?.phone??'');
        const unique=[...new Set(targets.rows.map(item=>normalizedSmsPhone(item.phone)).filter(phone=>phone&&phone!==actorPhone))];
        const eventDay=eventDate??new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        const eventClock=eventTime??new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tehran',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
        const variables:Record<string,string>={'ماشین':repair.machine_code,'پلاک':repair.plate??'','خرابی':repair.title,'مرحله':stageLabel,
          'تاریخ':new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium',timeZone:'Asia/Tehran'}).format(new Date(`${eventDay}T12:00:00Z`)),
          'ساعت':eventClock,'ثبت‌کننده':account.name,'تعمیرگاه':String(rawDetails.shop??repair.shop??''),'قطعه':String(rawDetails.part_name??''),
          'تحویل قطعه':rawDetails.part_eta?new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium',timeZone:'Asia/Tehran'}).format(new Date(`${String(rawDetails.part_eta)}T12:00:00Z`)):'',
          'نتیجه تست':outcome==='pass'?'قبول':outcome==='fail'?'رد':'','توضیح':eventNote||inputText(body?.repairer_note??'',4000)||inputText(body?.delay_reason??'',4000)};
        const message=renderSmsTemplate(smsRule.text,variables).slice(0,1000);
        const patternValues=Object.fromEntries(Object.entries(smsRule.pattern?.bindings??{}).map(([name,key])=>[name,String(variables[key]??'').slice(0,100)]));
        const queuedPattern=provider==='ippanel'&&smsRule.pattern?.ippanelCode?{code:smsRule.pattern.ippanelCode,parameters:patternValues}
          :provider==='smsir'&&smsRule.pattern?.templateId?{templateId:smsRule.pattern.templateId,parameters:Object.entries(patternValues).map(([name,value])=>({name,value}))}:null;
        for(const recipient of unique)await client.query(`INSERT INTO sms_messages(id,recipient,message,status,provider,created_by,smsir_pattern) VALUES($1,$2,$3,'queued',$4,$5,$6)`,[randomUUID(),recipient,message,provider,account.id,queuedPattern?JSON.stringify(queuedPattern):null]);
      }
      await client.query('COMMIT');
      return repair;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  @Post(':id/events/undo')
  async undoLastEvent(@Req() request: RequestHeaders, @Param('id', ParseUUIDPipe) id: string, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'status', 3);
    const version = body?.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 2 || version >= 2147483647) {
      throw new BadRequestException('Invalid version');
    }
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`SELECT id,stage,result,version,workflow FROM repairs WHERE id=$1 FOR UPDATE`, [id]);
      const repair = current.rows[0];
      if (!repair || repair.version !== version) throw new ConflictException('Repair already changed or unavailable');
      const active = await client.query(`SELECT id,revision,stage,before_state,details FROM repair_events
        WHERE repair_id=$1 AND voided_at IS NULL ORDER BY revision DESC LIMIT 1 FOR UPDATE`, [id]);
      const event = active.rows[0];
      if (!event || event.revision !== repair.version || event.stage !== repair.stage || !event.before_state?.stage) {
        throw new ConflictException('The latest repair stage cannot be undone');
      }
      const stageIndex=repair.workflow.indexOf(repair.stage);
      const isRepeat=event.details?.repeat_current==='true';
      if (stageIndex <= 0 || event.revision <= 1 || event.before_state.stage!==(isRepeat?repair.stage:repair.workflow[stageIndex-1])) {
        throw new ConflictException('The initial report cannot be undone');
      }
      const followUp = await client.query('SELECT 1 FROM repairs WHERE previous_repair_id=$1 LIMIT 1', [id]);
      if (followUp.rowCount) throw new ConflictException('A follow-up repair already exists');
      const before = event.before_state;
      const restored = await client.query(`UPDATE repairs SET stage=$3,result=$4,refer_date=$5::date,return_date=$6::date,
          repairer_note=$7,delay_reason=$8,shop=$9,expected_date=$10::date,version=version+1,updated_at=now()
        WHERE id=$1 AND version=$2
        RETURNING id,number,machine_id,previous_repair_id,title,urgency,shop,note,stage,result,version,created_at,updated_at,
          report_date::text AS report_date,diagnoser,expected_date::text AS expected_date,refer_date::text AS refer_date,
          repairer_note,return_date::text AS return_date,delay_reason`,
        [id, version, before.stage, before.result ?? null, before.refer_date ?? null, before.return_date ?? null,
          before.repairer_note ?? '', before.delay_reason ?? '',before.shop ?? '',before.expected_date ?? null]);
      if (!restored.rowCount) throw new ConflictException('Repair already changed or unavailable');
      await client.query('UPDATE repair_events SET voided_at=now(),voided_by=$2 WHERE id=$1 AND voided_at IS NULL', [event.id, account.id]);
      const withMachine = await client.query(`SELECT r.id,r.number,r.machine_id,r.previous_repair_id,previous.number AS previous_repair_number,
          r.title,r.urgency,r.shop,r.note,r.stage,r.result,r.version,r.workflow,r.created_at,r.updated_at,r.report_date::text AS report_date,
          r.diagnoser,r.expected_date::text AS expected_date,r.refer_date::text AS refer_date,r.repairer_note,
          r.return_date::text AS return_date,r.delay_reason,m.code AS machine_code
        FROM repairs r JOIN machines m ON m.id=r.machine_id LEFT JOIN repairs previous ON previous.id=r.previous_repair_id WHERE r.id=$1`, [id]);
      await client.query('COMMIT');
      return withMachine.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

@Controller('status')
class StatusController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async overview(@Req() request: RequestHeaders) {
    const account=await this.auth.access(request,'status',1);
    const stages=await configuredStages(this.database.pool);
    const visibleStageIds=account.scope_shop?stages.filter(stage=>stage.kind==='step').map(stage=>stage.id):null;
    const [machines,repairs]=await Promise.all([
      this.database.pool.query(`SELECT m.id,m.code,m.plate,m.type,latest.result AS last_repair_result FROM machines m
        LEFT JOIN LATERAL (SELECT r.result FROM repairs r WHERE r.machine_id=m.id
          ORDER BY r.created_at DESC,r.number DESC LIMIT 1) latest ON true
        WHERE m.active ORDER BY m.sort_order,m.id`),
      this.database.pool.query(`SELECT r.id,r.number,r.machine_id,r.title,r.shop,r.note,r.stage,r.urgency,r.result,r.version,r.workflow,
          r.created_at,r.updated_at,r.report_date::text AS report_date,r.expected_date::text AS expected_date,
          r.refer_date::text AS refer_date,r.return_date::text AS return_date,m.code AS machine_code,m.plate,m.type,
          (SELECT max(e.recorded_at) FROM repair_events e WHERE e.repair_id=r.id AND e.stage=r.stage AND e.voided_at IS NULL) AS current_stage_since,
          current_event.note AS current_note,current_event.details AS current_details,current_event.actor_name AS current_actor
        FROM repairs r JOIN machines m ON m.id=r.machine_id
        LEFT JOIN LATERAL (SELECT e.note,e.details,u.name AS actor_name FROM repair_events e LEFT JOIN users u ON u.id=e.actor_id
          WHERE e.repair_id=r.id AND e.stage=r.stage AND e.voided_at IS NULL ORDER BY e.revision DESC LIMIT 1) current_event ON true
        WHERE r.result IS NULL AND ($1::text[] IS NULL OR r.stage=ANY($1::text[]))
        ORDER BY r.updated_at ASC,r.number DESC`,[visibleStageIds]),
    ]);
    return { machines:account.scope_shop?[]:machines.rows,repairs:repairs.rows,stages,scope_shop:account.scope_shop };
  }

  @Get(':id/events')
  @Header('Cache-Control','no-store')
  async history(@Req() request:RequestHeaders,@Param('id',ParseUUIDPipe) id:string){
    const account=await this.auth.access(request,'status',1);
    const steps=account.scope_shop?(await configuredStages(this.database.pool)).filter(stage=>stage.kind==='step').map(stage=>stage.id):null;
    const result=await this.database.pool.query(`SELECT e.id,e.stage,e.result,e.note,e.details,e.recorded_at,e.voided_at,u.name AS actor_name
      FROM repair_events e JOIN users u ON u.id=e.actor_id JOIN repairs r ON r.id=e.repair_id
      WHERE e.repair_id=$1 AND ($2::text[] IS NULL OR r.stage=ANY($2::text[])) ORDER BY e.revision`,[id,steps]);
    if(!result.rowCount)throw new NotFoundException();
    return result.rows;
  }
}

function reading(value: unknown, max = 10000000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new BadRequestException('Invalid numeric value');
  }
  return value;
}

function calendarDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9999-12-31') {
    throw new BadRequestException('Invalid date');
  }
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException('Invalid date');
  return value;
}

@Controller('maintenance')
class MaintenanceController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async overview(@Req() request: RequestHeaders) {
    await this.auth.access(request, 'maint', 1);
    const [machines, parts, settings] = await Promise.all([
      this.database.pool.query(`SELECT m.id, m.code, m.unit, m.model_id, model.name AS model_name, o.reading::double precision AS reading,
         o.recorded_on::text AS reading_date
         FROM machines m LEFT JOIN machine_models model ON model.id = m.model_id
         LEFT JOIN LATERAL (
           SELECT reading, recorded_on FROM odometer_logs WHERE machine_id = m.id AND unit = m.unit
           ORDER BY recorded_on DESC, reading DESC, id DESC LIMIT 1
         ) o ON true WHERE m.active ORDER BY m.sort_order, m.id`),
      this.database.pool.query(`SELECT m.id AS machine_id, p.id, p.name, p.system,p.action,p.note,p.consequence,
         CASE WHEN m.unit = 'hour' THEN p.interval_hours ELSE p.interval_km END AS interval_reading,
         p.interval_months, last_log.recorded_on::text AS last_date,
         last_log.reading::double precision AS last_reading,
         (last_log.recorded_on + round(p.interval_months * 30.44)::integer)::text AS due_date,
         last_log.recorded_on + round(p.interval_months * 30.44)::integer -
           (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tehran')::date AS remaining_days
         FROM machines m JOIN model_parts p ON p.model_id = m.model_id
         LEFT JOIN LATERAL (
           SELECT recorded_on, reading FROM part_logs
           WHERE machine_id = m.id AND part_id = p.id AND unit = m.unit
           ORDER BY reading DESC NULLS LAST, recorded_on DESC, id DESC LIMIT 1
         ) last_log ON true WHERE m.active ORDER BY p.name, p.id`),
      this.database.pool.query("SELECT payload->>'warnPercent' AS warn_percent FROM app_settings WHERE singleton"),
    ]);
    const warnPercent = Math.max(1, Math.min(100, Number(settings.rows[0]?.warn_percent ?? 10))) / 100;
    const current = new Map(machines.rows.map(machine => [machine.id, machine.reading]));
    return {
      machines: machines.rows,
      parts: parts.rows.map(part => {
        const odometer = current.get(part.machine_id);
        const dueReading = part.interval_reading > 0 && part.last_reading !== null
          ? part.last_reading + part.interval_reading : null;
        const remainingReading = dueReading !== null && odometer != null ? dueReading - odometer : null;
        const remainingDays = part.interval_months > 0 ? part.remaining_days : null;
        const exceeded = (remainingReading !== null && remainingReading < 0) || (remainingDays !== null && remainingDays < 0);
        const soon = (remainingReading !== null && remainingReading <= part.interval_reading * warnPercent)
          || (remainingDays !== null && remainingDays <= part.interval_months * 30.44 * warnPercent);
        const readingUnknown = part.interval_reading > 0 && (part.last_reading === null || odometer == null);
        const state = !part.interval_reading && !part.interval_months ? 'na'
          : !part.last_date ? 'none' : exceeded ? 'over' : soon ? 'soon' : readingUnknown ? 'unknown' : 'ok';
        return {
          machine_id: part.machine_id, id: part.id, name: part.name, system: part.system, action: part.action, note: part.note, consequence: part.consequence, state,
          last_date: part.last_date, interval_reading: part.interval_reading, interval_months: part.interval_months,
          due_reading: dueReading, due_date: part.interval_months > 0 ? part.due_date : null,
          remaining_reading: remainingReading, remaining_days: remainingDays,
        };
      }),
    };
  }

  @Get(':machineId/history')
  @Header('Cache-Control', 'no-store')
  async history(@Req() request: RequestHeaders, @Param('machineId') machineId: string) {
    await this.auth.access(request, 'maint', 1);
    const [readings, services] = await Promise.all([
      this.database.pool.query(
        `SELECT id, recorded_on::text, reading, unit, note FROM odometer_logs
         WHERE machine_id = $1 ORDER BY recorded_on DESC, reading DESC, id DESC`, [machineId]),
      this.database.pool.query(
        `SELECT l.id, l.part_id, l.recorded_on::text, l.reading, l.unit, l.kind, l.note, COALESCE(NULLIF(l.part_name_snapshot,''),p.name,'قطعه حذف‌شده') AS name
         FROM part_logs l LEFT JOIN model_parts p ON p.id = l.part_id WHERE l.machine_id = $1
         ORDER BY l.recorded_on DESC, l.reading DESC NULLS LAST, l.id DESC`, [machineId]),
    ]);
    return { readings: readings.rows, services: services.rows };
  }

  @Post(':machineId/readings')
  async addReading(@Req() request: RequestHeaders, @Param('machineId') machineId: string, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'maint', 2);
    const result = await this.database.pool.query(
      `INSERT INTO odometer_logs (id, machine_id, recorded_on, reading, unit, recorded_by, note)
       SELECT $1, id, $3, $4, unit, $5, $6 FROM machines WHERE id = $2 AND active RETURNING id`,
      [randomUUID(), machineId, calendarDate(body?.date), reading(body?.reading, 1000000000),
        account.id, inputText(body?.note, 4000)],
    );
    if (!result.rowCount) throw new NotFoundException();
    return result.rows[0];
  }

  @Post(':machineId/services')
  async addService(@Req() request: RequestHeaders, @Param('machineId') machineId: string, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'maint', 2);
    const kind = body?.kind;
    const part = body?.part_id;
    if ((kind !== 'service' && kind !== 'replacement') || typeof part !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) {
      throw new BadRequestException('Invalid service');
    }
    const recordedOn = calendarDate(body?.date);
    const currentReading = body?.reading == null || body.reading === '' ? null : reading(body.reading, 1000000000);
    const note = inputText(body?.note, 4000);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const machine = await client.query('SELECT id, model_id, unit FROM machines WHERE id=$1 AND active FOR UPDATE', [inputText(machineId, 100, true)]);
      if (!machine.rowCount) throw new NotFoundException();
      const result = await client.query(
        `INSERT INTO part_logs (id, machine_id, part_id, recorded_on, reading, unit, kind, recorded_by, note)
         SELECT $1, m.id, p.id, $4, $5, m.unit, $6, $7, $8 FROM machines m
         JOIN model_parts p ON p.model_id = m.model_id WHERE m.id = $2 AND m.active AND p.id = $3 RETURNING id`,
        [randomUUID(), machineId, part, recordedOn, currentReading, kind, account.id, note],
      );
      if (!result.rowCount) throw new BadRequestException('Invalid machine and part combination');
      if (currentReading !== null) {
        const last = await client.query('SELECT reading FROM odometer_logs WHERE machine_id=$1 AND unit=$2 ORDER BY recorded_on DESC,reading DESC,id DESC LIMIT 1', [machineId, machine.rows[0].unit]);
        if (!last.rowCount || Number(currentReading) > Number(last.rows[0].reading)) await client.query(
          'INSERT INTO odometer_logs(id,machine_id,recorded_on,reading,unit,recorded_by,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), machineId, recordedOn, currentReading, machine.rows[0].unit, account.id, 'کارکرد ثبت‌شده همراه سرویس'],
        );
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Post(':machineId/services/bulk')
  async addBulkServices(@Req() request:RequestHeaders,@Param('machineId') machineId:string,@Body() body?:MachineInput){
    requireMutationHeader(request);
    const account=await this.auth.access(request,'maint',2);
    const ids=body?.part_ids;
    if(!Array.isArray(ids)||ids.length<1||ids.length>200||ids.some(id=>typeof id!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(id))||new Set(ids).size!==ids.length)
      throw new BadRequestException('فهرست قطعات سرویس اولیه معتبر نیست.');
    const recordedOn=calendarDate(body?.date);
    const currentReading=body?.reading==null||body.reading===''?null:reading(body.reading,1000000000);
    const note=inputText(body?.note??'سرویس اولیه',4000);
    const client=await this.database.pool.connect();
    try{
      await client.query('BEGIN');
      const machine=await client.query('SELECT id,model_id,unit FROM machines WHERE id=$1 AND active FOR UPDATE',[inputText(machineId,100,true)]);
      if(!machine.rowCount)throw new NotFoundException();
      const valid=await client.query('SELECT id,action FROM model_parts WHERE model_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',[machine.rows[0].model_id,ids]);
      if(valid.rowCount!==ids.length)throw new BadRequestException('یکی از قطعات برای این ماشین معتبر نیست.');
      const inserted=await client.query(`INSERT INTO part_logs(id,machine_id,part_id,recorded_on,reading,unit,kind,recorded_by,note)
        SELECT gen_random_uuid(),$1,p.id,$3,$4,$5,CASE WHEN p.action='r' THEN 'replacement' ELSE 'service' END,$6,$7
        FROM model_parts p WHERE p.id=ANY($2::uuid[]) AND p.model_id=$8 RETURNING id`,
        [machine.rows[0].id,ids,recordedOn,currentReading,machine.rows[0].unit,account.id,note,machine.rows[0].model_id]);
      if(currentReading!==null){
        const last=await client.query('SELECT reading FROM odometer_logs WHERE machine_id=$1 AND unit=$2 ORDER BY recorded_on DESC,reading DESC,id DESC LIMIT 1',[machine.rows[0].id,machine.rows[0].unit]);
        if(!last.rowCount||Number(currentReading)>Number(last.rows[0].reading))await client.query(
          'INSERT INTO odometer_logs(id,machine_id,recorded_on,reading,unit,recorded_by,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(),machine.rows[0].id,recordedOn,currentReading,machine.rows[0].unit,account.id,'کارکرد ثبت‌شده همراه سرویس اولیه']);
      }
      await client.query('COMMIT');
      return {created:inserted.rowCount};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  @Delete(':machineId/services/:id')
  async deleteService(@Req() request:RequestHeaders,@Param('machineId') machineId:string,@Param('id',ParseUUIDPipe) id:string){
    requireMutationHeader(request);
    await this.auth.access(request,'maint',2);
    const result=await this.database.pool.query('DELETE FROM part_logs WHERE id=$1 AND machine_id=$2 RETURNING id',[id,inputText(machineId,100,true)]);
    if(!result.rowCount)throw new NotFoundException();
    return {deleted:true};
  }
}

@Controller('parts')
class PartsController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async catalog(@Req() request: RequestHeaders) {
    await this.auth.access(request, 'parts', 1);
    const [models, parts, alternatives] = await Promise.all([
      this.database.pool.query(`SELECT md.id,md.name,
        COALESCE((SELECT json_agg(m.code ORDER BY m.sort_order) FROM machines m WHERE m.model_id=md.id),'[]'::json) AS machine_codes,
        (SELECT count(*) FROM model_parts p WHERE p.model_id=md.id)::int AS part_count,
        (SELECT count(*) FROM model_parts p WHERE p.model_id=md.id AND EXISTS(SELECT 1 FROM part_alternatives a WHERE a.part_id=p.id))::int AS alternative_count,
        (SELECT min(m.sort_order) FROM machines m WHERE m.model_id=md.id) AS first_machine_order
        FROM machine_models md ORDER BY first_machine_order NULLS LAST,md.name,md.id`),
      this.database.pool.query('SELECT * FROM model_parts ORDER BY name, id'),
      this.database.pool.query('SELECT * FROM part_alternatives ORDER BY name, id'),
    ]);
    return { models: models.rows, parts: parts.rows, alternatives: alternatives.rows };
  }

  @Post()
  async createPart(@Req() request: RequestHeaders, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    await this.auth.access(request, 'parts', 2);
    const result = await this.database.pool.query(
      `INSERT INTO model_parts(id, model_id, name, system, interval_km, interval_hours, interval_months, action, note, consequence)
       SELECT $1, id, $3, $4, $5, $6, $7, $8, $9, $10 FROM machine_models WHERE id = $2 RETURNING id`,
      [randomUUID(), inputText(body?.model_id, 100, true), inputText(body?.name, 150, true),
        inputText(body?.system, 100), reading(body?.interval_km), reading(body?.interval_hours), reading(body?.interval_months, 120),
        ['r','i','s','a','c'].includes(String(body?.action)) ? body?.action : 'r', inputText(body?.note, 4000), inputText(body?.consequence, 4000)],
    );
    if (!result.rowCount) throw new NotFoundException();
    return result.rows[0];
  }

  @Patch(':id')
  async editPart(@Req() request:RequestHeaders,@Param('id',ParseUUIDPipe) id:string,@Body() body?:MachineInput){
    requireMutationHeader(request);
    await this.auth.access(request,'parts',2);
    const result=await this.database.pool.query(`UPDATE model_parts SET name=$2,system=$3,interval_km=$4,interval_hours=$5,
      interval_months=$6,action=$7,note=$8,consequence=$9 WHERE id=$1 RETURNING id`,
      [id,inputText(body?.name,150,true),inputText(body?.system,100),reading(body?.interval_km),reading(body?.interval_hours),
        reading(body?.interval_months,120),['r','i','s','a','c'].includes(String(body?.action))?body?.action:'r',
        inputText(body?.note,4000),inputText(body?.consequence,4000)]);
    if(!result.rowCount)throw new NotFoundException();
    return result.rows[0];
  }

  @Delete()
  async deleteParts(@Req() request:RequestHeaders,@Body() body?:MachineInput){
    requireMutationHeader(request);
    await this.auth.access(request,'parts',2);
    const modelId=inputText(body?.model_id,100,true);
    const rawIds=body?.part_ids;
    if(!Array.isArray(rawIds)||rawIds.length<1||rawIds.length>200)throw new BadRequestException('Invalid part selection');
    const ids=rawIds.map(value=>inputText(value,36,true));
    if(ids.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))||new Set(ids).size!==ids.length)throw new BadRequestException('Invalid part selection');
    const client=await this.database.pool.connect();
    try{
      await client.query('BEGIN');
      const selected=await client.query('SELECT id FROM model_parts WHERE model_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',[modelId,ids]);
      if(selected.rowCount!==ids.length)throw new BadRequestException('The selected parts changed. Reload and try again.');
      await client.query(`UPDATE part_logs l SET part_name_snapshot=p.name,part_system_snapshot=p.system
        FROM model_parts p WHERE p.id=ANY($1::uuid[]) AND l.part_id=p.id`,[ids]);
      await client.query('DELETE FROM part_alternatives WHERE part_id=ANY($1::uuid[])',[ids]);
      await client.query('DELETE FROM model_parts WHERE id=ANY($1::uuid[])',[ids]);
      await client.query('COMMIT');
      return {deleted:ids.length,history_preserved:true};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  @Delete(':id')
  async deletePart(@Req() request:RequestHeaders,@Param('id',ParseUUIDPipe) id:string){
    requireMutationHeader(request);
    await this.auth.access(request,'parts',2);
    const client=await this.database.pool.connect();
    try{
      await client.query('BEGIN');
      const existing=await client.query('SELECT id FROM model_parts WHERE id=$1 FOR UPDATE',[id]);
      if(!existing.rowCount)throw new NotFoundException();
      await client.query(`UPDATE part_logs l SET part_name_snapshot=p.name,part_system_snapshot=p.system
        FROM model_parts p WHERE p.id=$1 AND l.part_id=p.id`,[id]);
      await client.query('DELETE FROM part_alternatives WHERE part_id=$1',[id]);
      await client.query('DELETE FROM model_parts WHERE id=$1',[id]);
      await client.query('COMMIT');
      return {deleted:true,history_preserved:true};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  @Post(':id/alternatives')
  async addAlternative(@Req() request: RequestHeaders, @Param('id', ParseUUIDPipe) id: string, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    await this.auth.access(request, 'parts', 2);
    if (typeof body?.approved !== 'boolean') throw new BadRequestException('Invalid approval');
    const result = await this.database.pool.query(
      `INSERT INTO part_alternatives(id, part_id, name, source, note, approved)
       SELECT $1, id, $3, $4, $5, $6 FROM model_parts WHERE id = $2 RETURNING id`,
      [randomUUID(), id, inputText(body.name, 150, true), inputText(body.source, 150), inputText(body.note, 4000), body.approved],
    );
    if (!result.rowCount) throw new NotFoundException();
    return result.rows[0];
  }

  @Patch(':id/alternatives/:alternativeId')
  async editAlternative(@Req() request:RequestHeaders,@Param('id',ParseUUIDPipe) id:string,@Param('alternativeId',ParseUUIDPipe) alternativeId:string,@Body() body?:MachineInput){
    requireMutationHeader(request);
    await this.auth.access(request,'parts',2);
    if(typeof body?.approved!=='boolean')throw new BadRequestException('Invalid approval');
    const result=await this.database.pool.query(`UPDATE part_alternatives a SET name=$3,source=$4,note=$5,approved=$6
      FROM model_parts p WHERE a.id=$1 AND a.part_id=$2 AND p.id=a.part_id RETURNING a.id,a.part_id,a.name,a.source,a.note,a.approved`,
      [alternativeId,id,inputText(body?.name,150,true),inputText(body?.source,150),inputText(body?.note,4000),body.approved]);
    if(!result.rowCount)throw new NotFoundException();
    return result.rows[0];
  }

  @Delete(':id/alternatives/:alternativeId')
  async deleteAlternative(@Req() request:RequestHeaders,@Param('id',ParseUUIDPipe) id:string,@Param('alternativeId',ParseUUIDPipe) alternativeId:string){
    requireMutationHeader(request);
    await this.auth.access(request,'parts',2);
    const result=await this.database.pool.query('DELETE FROM part_alternatives WHERE id=$1 AND part_id=$2 RETURNING id',[alternativeId,id]);
    if(!result.rowCount)throw new NotFoundException();
    return {deleted:true};
  }

}

@Controller('dashboard')
class DashboardController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async summary(@Req() request: RequestHeaders) {
    await this.auth.access(request, 'dashboard', 1);
    const [counts, stages, daily] = await Promise.all([
      this.database.pool.query(`SELECT
        (SELECT count(*)::int FROM machines WHERE active) AS active_machines,
        (SELECT count(*)::int FROM repairs WHERE result IS NULL) AS open_repairs,
        (SELECT count(*)::int FROM repairs WHERE result IS NOT NULL) AS archived_repairs,
        (SELECT count(*)::int FROM part_logs) AS service_records,
        (SELECT count(*)::int FROM analyses) AS analyses`),
      this.database.pool.query('SELECT stage, count(*)::int AS total FROM repairs GROUP BY stage'),
      this.database.pool.query(`WITH today AS (
          SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tehran')::date AS local_day
        ), days AS (
          SELECT local_day - offset_days AS day FROM today CROSS JOIN generate_series(0, 6) AS offset_days
        )
        SELECT days.day::text, count(r.id)::int AS total
        FROM days LEFT JOIN repairs r ON (r.created_at AT TIME ZONE 'Asia/Tehran')::date = days.day
        GROUP BY days.day ORDER BY days.day`),
    ]);
    return { ...counts.rows[0], stages: stages.rows, daily: daily.rows };
  }
}

@Controller('reports')
class ReportsController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  @Get('repairs')
  @Header('Cache-Control', 'no-store')
  async repairs(@Req() request: RequestHeaders) {
    const account=await this.auth.access(request, 'repairs', 1);
    const steps=account.scope_shop?(await configuredStages(this.database.pool)).filter(stage=>stage.kind==='step').map(stage=>stage.id):null;
    return (await this.database.pool.query(`SELECT r.id,r.number,r.created_at,r.report_date::text,r.refer_date::text,r.expected_date::text,r.return_date::text,
        r.diagnoser,r.repairer_note,r.delay_reason,r.note,m.code AS machine_code,r.title,r.urgency,r.shop,r.stage,r.result,r.updated_at,
        (SELECT e.recorded_at::date::text FROM repair_events e WHERE e.repair_id=r.id AND e.stage=r.workflow[cardinality(r.workflow)-1] AND e.result IS NULL AND e.voided_at IS NULL ORDER BY e.revision DESC LIMIT 1) AS repair_completed_date,
        (SELECT e.recorded_at::date::text FROM repair_events e WHERE e.repair_id=r.id AND e.stage=r.workflow[cardinality(r.workflow)] AND e.result IS NOT NULL AND e.voided_at IS NULL ORDER BY e.revision DESC LIMIT 1) AS test_completed_date,
        (SELECT e.note FROM repair_events e WHERE e.repair_id=r.id AND e.stage=r.workflow[cardinality(r.workflow)] AND e.result IS NOT NULL AND e.voided_at IS NULL ORDER BY e.revision DESC LIMIT 1) AS test_note,
        (SELECT max(e.recorded_at) FROM repair_events e WHERE e.repair_id=r.id AND e.stage=r.stage AND e.voided_at IS NULL) AS current_stage_since
      FROM repairs r JOIN machines m ON m.id=r.machine_id WHERE $1::text[] IS NULL OR r.stage=ANY($1::text[])
      ORDER BY r.created_at DESC,r.number DESC`,[steps])).rows;
  }
}

@Controller('sms')
class SmsController implements OnModuleInit, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private pumping = false;

  constructor(private readonly database: Database, private readonly auth: Auth) {}

  onModuleInit() {
    if (process.env.SMS_WORKER_DISABLED === 'true') return;
    this.timer = setInterval(() => void this.processNext(), 750);
    if (process.argv.includes('--worker')) this.timer.ref();
  }

  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  @Get('recipients')
  @Header('Cache-Control','no-store')
  async recipients(@Req() request:RequestHeaders){
    await this.auth.access(request,'sms',1);
    return (await this.database.pool.query(`
      SELECT p.name AS name,CASE p.role WHEN 'supervisor' THEN 'سرپرست' ELSE 'مسئول PM' END AS role,
        coalesce(nullif(linked.phone,''),nullif(p.phone,''),'') AS phone
      FROM people p LEFT JOIN LATERAL (SELECT u.phone FROM users u WHERE u.person_id=p.id AND u.active AND u.phone<>'' ORDER BY u.receive_sms DESC,u.id LIMIT 1) linked ON true
      WHERE p.active AND p.role IN ('supervisor','pm')
      UNION ALL
      SELECT u.name,CASE WHEN u.is_super_admin THEN 'مدیر کل' ELSE 'گیرنده همه پیامک‌ها' END,u.phone
      FROM users u WHERE u.active AND (u.is_super_admin OR u.receive_sms)
      ORDER BY name
    `)).rows;
  }

  @Get('rules')
  @Header('Cache-Control','no-store')
  async rules(@Req() request:RequestHeaders){
    await this.auth.access(request,'sms',1);
    const [settings,stages]=await Promise.all([
      this.database.pool.query("SELECT revision,payload->'smsRules' AS rules,coalesce((payload->>'smsStageAlerts')::boolean,false) AS enabled FROM app_settings WHERE singleton"),
      configuredStages(this.database.pool),
    ]);
    const saved=settings.rows[0];
    const rules=Object.fromEntries(stages.map(stage=>[stage.id,smsRuleFor(saved?.rules,stage)]));
    return {revision:saved?.revision??1,enabled:saved?.enabled??false,stages,rules};
  }

  @Put('rules')
  async saveRules(@Req() request:RequestHeaders,@Body() body?:MachineInput){
    requireMutationHeader(request);
    await this.auth.access(request,'sms',2);
    const revision=body?.revision;
    const enabled=body?.enabled;
    if(!Number.isInteger(revision)||Number(revision)<1)throw new BadRequestException('Invalid settings revision');
    if(typeof enabled!=='boolean')throw new BadRequestException('Invalid automatic SMS setting');
    const stages=await configuredStages(this.database.pool);
    const input=body?.rules;
    if(!input||typeof input!=='object'||Array.isArray(input))throw new BadRequestException('Invalid SMS rules');
    const provided=input as Record<string,unknown>;
    if(Object.keys(provided).length>12||Object.keys(provided).some(id=>!stages.some(stage=>stage.id===id)))throw new BadRequestException('Unknown SMS stage');
    const normalized:Record<string,SmsStageRule>={};
    for(const stage of stages){
      const raw=provided[stage.id]??smsRuleFor(provided,stage);
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('Invalid SMS rule');
      const rule=raw as Record<string,unknown>;
      if(typeof rule.on!=='boolean'||!Array.isArray(rule.to)||rule.to.length>4||rule.to.some(value=>typeof value!=='string'||!(smsRecipientKeys as readonly string[]).includes(value)&&value!=='sup'&&value!=='all')||new Set(rule.to).size!==rule.to.length)throw new BadRequestException('Invalid SMS recipients');
      let pattern:SmsStageRule['pattern']=null;
      if(rule.pattern!==undefined&&rule.pattern!==null){
        const candidate=rule.pattern as Record<string,unknown>;
        const templateId=Number.isSafeInteger(candidate?.templateId)&&Number(candidate.templateId)>0?Number(candidate.templateId):null;
        const ippanelCode=typeof candidate?.ippanelCode==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(candidate.ippanelCode)?candidate.ippanelCode:'';
        if(!candidate||typeof candidate!=='object'||(!templateId&&!ippanelCode)||!candidate.bindings||typeof candidate.bindings!=='object'||Array.isArray(candidate.bindings))throw new BadRequestException('شناسه یا کد پترن و نگاشت متغیرهای آن نامعتبر است.');
        const allowedVariables=['ماشین','پلاک','خرابی','مرحله','تاریخ','ساعت','ثبت‌کننده','تعمیرگاه','قطعه','تحویل قطعه','نتیجه تست','توضیح'];
        const bindings=candidate.bindings as Record<string,unknown>;
        if(Object.keys(bindings).length>10||Object.entries(bindings).some(([name,key])=>! /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)||typeof key!=='string'||!allowedVariables.includes(key)))throw new BadRequestException('نگاشت پارامترهای پترن معتبر نیست.');
        pattern={templateId,ippanelCode,bindings:bindings as Record<string,string>};
      }
      normalized[stage.id]={on:rule.on,to:[...new Set((rule.to as string[]).flatMap(value=>value==='sup'?['supervisor']:value==='all'?[]:[value]))],text:inputText(rule.text,1000,true),pattern};
    }
    const client=await this.database.pool.connect();
    try{
      await client.query('BEGIN');
      const saved=await client.query(`UPDATE app_settings SET payload=jsonb_set(jsonb_set(payload,'{smsRules}',$1::jsonb,true),'{smsStageAlerts}',to_jsonb($2::boolean),true),revision=revision+1,updated_at=now()
        WHERE singleton AND revision=$3 RETURNING revision,payload->'smsRules' AS rules,coalesce((payload->>'smsStageAlerts')::boolean,false) AS enabled`,[normalized,enabled,revision]);
      if(!saved.rowCount)throw new ConflictException('Settings changed; refresh and try again');
      await client.query(`UPDATE legacy_workspace SET payload=jsonb_set(COALESCE(payload,'{}'::jsonb),'{settings}',
        COALESCE(payload->'settings','{}'::jsonb)||jsonb_build_object('sms',COALESCE(payload#>'{settings,sms}','{}'::jsonb)||jsonb_build_object('rules',$1::jsonb,'enabled',$2::boolean)),true),
        revision=revision+1,updated_at=now() WHERE singleton`,[normalized,enabled]);
      await client.query('COMMIT');
      return {...saved.rows[0],stages};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  private async processNext() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.database.pool.query("UPDATE sms_messages SET status='unconfirmed' WHERE status='sending' AND started_at<now()-interval '30 seconds'");
      const claimed = await this.database.pool.query(`WITH next_message AS (
          SELECT id FROM sms_messages WHERE status='queued' AND next_attempt_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE sms_messages SET status='sending',attempts=attempts+1,started_at=now()
          WHERE id=(SELECT id FROM next_message) RETURNING id,recipient,message,provider,smsir_pattern`);
      const item = claimed.rows[0];
      if (!item) return;
      let status: 'accepted' | 'failed' | 'unconfirmed' = 'accepted';
      let providerId = item.provider === 'mock' ? 'mock' : '';
      let responseCode: number | null = item.provider === 'mock' ? 200 : null;
      if (item.provider === 'kavenegar') {
        const apiKey = process.env.KAVENEGAR_API_KEY;
        const sender = process.env.KAVENEGAR_SENDER;
        if (!apiKey || !sender) status = 'failed';
        else {
          const recipient = String(item.recipient);
          const normalized = recipient.startsWith('+98') || recipient.startsWith('0098') ? recipient : recipient.startsWith('0') ? recipient : `0${recipient}`;
          try {
            const response = await fetch(`https://api.kavenegar.com/v1/${encodeURIComponent(apiKey)}/sms/send.json`, {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ receptor: normalized, sender, message: String(item.message) }), signal: AbortSignal.timeout(8000),
            });
            const result = await response.json() as { return?: { status?: number }; entries?: { messageid?: number | string }[] };
            responseCode = Number.isInteger(result.return?.status) ? Number(result.return?.status) : response.status;
            if (!response.ok || responseCode !== 200) status = 'failed';
            else providerId = String(result.entries?.[0]?.messageid ?? '');
          } catch { status = 'unconfirmed'; }
        }
      } else if (item.provider === 'smsir') {
        const stored = await storedSmsIr(this.database.pool);
        ({ status, providerId, responseCode } = await sendSmsIr(
          item.recipient, item.message, stored?.enabled === false ? null : effectiveSmsIr(stored), item.smsir_pattern as SmsIrPattern|undefined,
        ));
      } else if (item.provider === 'ippanel') {
        const stored=await storedSmsIr(this.database.pool);
        ({status,providerId,responseCode}=await sendIPPanel(item.recipient,item.message,stored?.enabled===false?null:effectiveIPPanel(await storedIPPanel(this.database.pool)),item.smsir_pattern as IPPanelPattern|undefined));
      } else if (item.provider !== 'mock') status = 'failed';
      await this.database.pool.query("UPDATE sms_messages SET status=$2,provider_message_id=$3,response_code=$4 WHERE id=$1 AND status='sending'",
        [item.id,status,providerId,responseCode]);
    } catch { /* Unclaimed messages remain available to the next poll. */ }
    finally { this.pumping = false; }
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async status(@Req() request: RequestHeaders) {
    const account = await this.auth.access(request, 'sms', 1);
    const stored = await storedSmsIr(this.database.pool);
    const provider = selectedSmsProvider(stored);
    const configured = provider==='ippanel'
      ?smsProviderConfigured(provider,effectiveIPPanel(await storedIPPanel(this.database.pool)))
      :smsProviderConfigured(provider, effectiveSmsIr(stored));
    const messages = await this.database.pool.query(`SELECT m.id,m.recipient,m.message,m.status,m.provider,m.provider_message_id,m.response_code,m.attempts,m.retry_of,m.created_at,
        (SELECT count(*)::int FROM sms_messages retry WHERE retry.retry_of=coalesce(m.retry_of,m.id)) AS retry_count
      FROM sms_messages m ORDER BY m.created_at DESC LIMIT 50`);
    const smsSettings = account.is_super_admin ? {
      keyStored: !!effectiveSmsIr(stored)?.apiKey, lineNumber: stored?.line_number ?? '', loginTemplateId:stored?.login_template_id??null,
      ippanelKeyStored:!!effectiveIPPanel(await storedIPPanel(this.database.pool))?.apiKey, ippanelSender:stored?.ippanel_sender??'', ippanelLoginPatternCode:stored?.ippanel_login_pattern_code??'',
      ippanelNameParameter:stored?.ippanel_name_parameter??'NAME',ippanelCodeParameter:stored?.ippanel_code_parameter??'CODE',
      selectedProvider:stored?.provider??provider,enabled:provider!=='mock',
      storageReady: !!smsEncryptionKey(),
    } : undefined;
    return { provider, configured, messages: messages.rows, smsSettings };
  }

  @Put('provider')
  @Header('Cache-Control', 'no-store')
  async saveProvider(@Req() request: RequestHeaders, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    const account = await this.auth.current(request);
    if (!account.is_super_admin) throw new ForbiddenException();
    const key = smsEncryptionKey();
    if (!key) throw new ServiceUnavailableException('کلید رمزنگاری تنظیمات پیامک در سرور آماده نیست.');
    const provider = inputText(body?.provider ?? 'smsir', 16);
    const apiKey = inputText(body?.apiKey ?? '', 256);
    const line = inputText(body?.lineNumber??'', 16);
    const loginTemplate=body?.loginTemplateId===''||body?.loginTemplateId===null||body?.loginTemplateId===undefined?null:Number(body.loginTemplateId);
    const senderInput=inputText(body?.ippanelSender??'',60);
    const sender=normalizeIPPanelSender(senderInput);
    const loginPatternCode=inputText(body?.ippanelLoginPatternCode??'',128);
    const nameParameter=inputText(body?.ippanelNameParameter??'NAME',40);
    const codeParameter=inputText(body?.ippanelCodeParameter??'CODE',40);
    const existing=await storedSmsIr(this.database.pool);
    const ippanelKeyEncrypted=apiKey&&provider==='ippanel'?encryptSmsKey(apiKey,key):existing?.ippanel_api_key_encrypted??null;
    const smsIrKeyEncrypted=apiKey&&provider==='smsir'?encryptSmsKey(apiKey,key):existing?.api_key_encrypted??encryptSmsKey('',key);
    const chosenSender=sender||existing?.ippanel_sender||'';
    if (!['mock','smsir','ippanel'].includes(provider)
      || (line&&(!/^[1-9]\d*$/.test(line)||!Number.isSafeInteger(Number(line))))
      || (loginTemplate!==null&&(!Number.isSafeInteger(loginTemplate)||loginTemplate<1))
      || (senderInput&&!sender)
      || (loginPatternCode&&!/^[A-Za-z0-9_-]{1,128}$/.test(loginPatternCode))
      || (nameParameter&&!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(nameParameter))
      || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(codeParameter)
      || (nameParameter&&nameParameter===codeParameter)
      || typeof body?.enabled !== 'boolean' || (apiKey && !/^[!-~]+$/.test(apiKey))
      || (body.enabled&&provider==='ippanel'&&(!(apiKey||effectiveIPPanel(existing)?.apiKey||process.env.IPPANEL_API_KEY)||!normalizeIPPanelSender(chosenSender)))
      || (body.enabled&&provider==='smsir'&&!(apiKey||effectiveSmsIr(existing)?.apiKey||process.env.SMSIR_API_KEY))) {
      throw new BadRequestException('کلید API یا شمارهٔ خط نامعتبر است.');
    }
    const savedLine=provider==='smsir'?(line||existing?.line_number||null):(existing?.line_number??null);
    const savedLoginTemplate=provider==='smsir'?loginTemplate:(existing?.login_template_id??null);
    const savedLoginCode=provider==='ippanel'?loginPatternCode:(existing?.ippanel_login_pattern_code??null);
    const savedSender=provider==='ippanel'?(sender||existing?.ippanel_sender||null):(existing?.ippanel_sender??null);
    const result=await this.database.pool.query(
      `INSERT INTO sms_ir_settings(singleton,api_key_encrypted,line_number,enabled,login_template_id,provider,ippanel_api_key_encrypted,ippanel_sender,ippanel_login_pattern_code,ippanel_name_parameter,ippanel_code_parameter)
       VALUES(true,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(singleton) DO UPDATE SET api_key_encrypted=excluded.api_key_encrypted,line_number=excluded.line_number,enabled=excluded.enabled,
        login_template_id=excluded.login_template_id,provider=excluded.provider,ippanel_api_key_encrypted=excluded.ippanel_api_key_encrypted,
        ippanel_sender=excluded.ippanel_sender,ippanel_login_pattern_code=excluded.ippanel_login_pattern_code,
        ippanel_name_parameter=excluded.ippanel_name_parameter,ippanel_code_parameter=excluded.ippanel_code_parameter`,
      [smsIrKeyEncrypted,savedLine,body.enabled, savedLoginTemplate,provider,ippanelKeyEncrypted,savedSender,savedLoginCode,nameParameter,codeParameter],
    );
    const updated=await storedSmsIr(this.database.pool);
    return { provider, keyStored: !!effectiveSmsIr(updated)?.apiKey, lineNumber: savedLine??'', loginTemplateId:savedLoginTemplate,
      ippanelKeyStored:!!effectiveIPPanel(updated)?.apiKey,ippanelSender:savedSender??'',ippanelLoginPatternCode:savedLoginCode??'',
      ippanelNameParameter:nameParameter,ippanelCodeParameter:codeParameter,enabled:body.enabled,storageReady:true };
  }

  @Get('ippanel/patterns')
  @Header('Cache-Control','no-store')
  async ippanelPatterns(@Req() request:RequestHeaders){
    const account=await this.auth.current(request);if(!account.is_super_admin)throw new ForbiddenException();
    const patterns=await listIPPanelPatterns(effectiveIPPanel(await storedIPPanel(this.database.pool)));
    if(!patterns)throw new ServiceUnavailableException('دریافت قالب‌های IPPanel ناموفق بود؛ کلید و اتصال پنل را بررسی کنید.');
    return patterns;
  }

  @Get(':id/delivery')
  @Header('Cache-Control', 'no-store')
  async delivery(@Req() request: RequestHeaders, @Param('id', ParseUUIDPipe) id: string) {
    await this.auth.access(request, 'sms', 2);
    const result = await this.database.pool.query<{ provider_message_id: string;provider:string }>(
      "SELECT provider_message_id,provider FROM sms_messages WHERE id=$1 AND provider IN ('smsir','ippanel') AND provider_message_id<>''", [id],
    );
    if (!result.rowCount) throw new NotFoundException('شناسهٔ گزارش پیامک یافت نشد.');
    const stored=await storedSmsIr(this.database.pool);
    const delivery = result.rows[0].provider==='ippanel'
      ?await ippanelDelivery(result.rows[0].provider_message_id,effectiveIPPanel(await storedIPPanel(this.database.pool)))
      :await smsIrDelivery(result.rows[0].provider_message_id,effectiveSmsIr(stored)?.apiKey??'');
    if (!delivery) throw new ServiceUnavailableException('استعلام وضعیت پیامک در دسترس نیست.');
    return {...delivery,provider:result.rows[0].provider};
  }

  @Post(':id/retry')
  async retry(@Req() request: RequestHeaders, @Param('id', ParseUUIDPipe) id: string) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'sms', 2);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{id:string;recipient:string;message:string;provider:string;status:string;provider_message_id:string;attempts:number;retry_of:string|null;smsir_pattern:SmsIrPattern|null}>(
        'SELECT id,recipient,message,provider,status,provider_message_id,attempts,retry_of,smsir_pattern FROM sms_messages WHERE id=$1 FOR UPDATE', [id],
      );
      const message = selected.rows[0];
      if (!message) throw new NotFoundException('پیامک پیدا نشد.');
      if (message.status !== 'failed' || message.provider_message_id || message.attempts < 1) {
        throw new BadRequestException('فقط پیام ناموفق با خطای قطعی و بدون شناسهٔ سرویس قابل ارسال مجدد است.');
      }
      const rootId = message.retry_of ?? message.id;
      await client.query('SELECT id FROM sms_messages WHERE id=$1 FOR UPDATE', [rootId]);
      const retries = await client.query<{total:number}>('SELECT count(*)::int AS total FROM sms_messages WHERE retry_of=$1', [rootId]);
      if (retries.rows[0].total >= 2) throw new ForbiddenException('برای این پیامک بیش از دو بار ارسال مجدد مجاز نیست.');
      const recent = await client.query<{total:number}>("SELECT count(*)::int AS total FROM sms_messages WHERE created_by=$1 AND created_at>now()-interval '1 minute'", [account.id]);
      if (recent.rows[0].total >= 5) throw new ForbiddenException('در هر دقیقه حداکثر پنج پیامک مجاز است.');
      const stored = await storedSmsIr(this.database.pool);
      const configured=message.provider==='ippanel'
        ?smsProviderConfigured(message.provider,stored?.enabled===false?null:effectiveIPPanel(await storedIPPanel(this.database.pool)))
        :smsProviderConfigured(message.provider, stored?.enabled === false ? null : effectiveSmsIr(stored));
      if (!configured) {
        throw new ServiceUnavailableException('پنل پیامک برای ارسال مجدد پیکربندی نشده است.');
      }
      const saved = await client.query(`INSERT INTO sms_messages(id,recipient,message,status,provider,created_by,retry_of,smsir_pattern)
        VALUES($1,$2,$3,'queued',$4,$5,$6,$7)
        RETURNING id,recipient,message,status,provider,provider_message_id,response_code,attempts,retry_of,created_at`,
        [randomUUID(), message.recipient, message.message, message.provider, account.id, rootId, message.smsir_pattern?JSON.stringify(message.smsir_pattern):null]);
      await client.query('COMMIT');
      return saved.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  @Post('test')
  async sendTest(@Req() request: RequestHeaders, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'sms', 2);
    const recent = await this.database.pool.query('SELECT count(*)::int AS total FROM sms_messages WHERE created_by=$1 AND created_at>now()-interval \'1 minute\'', [account.id]);
    if (recent.rows[0].total >= 5) throw new ForbiddenException('SMS rate limit reached');
    const recipient = inputText(body?.recipient, 30, true).replace(/[\s()-]/g, '');
    if (!/^(?:\+98|0098|0)?9\d{9}$/.test(recipient)) throw new BadRequestException('Invalid recipient');
    const message = inputText(body?.message, 1000, true);
    const stored = await storedSmsIr(this.database.pool);
    const provider = selectedSmsProvider(stored);
    if (body?.expectedProvider !== undefined && body.expectedProvider !== provider) throw new ConflictException('سرویس پیامک تغییر کرده است. صفحه را تازه کنید.');
    const configured=provider==='ippanel'?smsProviderConfigured(provider,effectiveIPPanel(await storedIPPanel(this.database.pool))):smsProviderConfigured(provider,effectiveSmsIr(stored));
    if (!configured) throw new ServiceUnavailableException('SMS provider is not configured');
    if(provider==='smsir'&&!effectiveSmsIr(stored)?.lineNumber)throw new ServiceUnavailableException('برای ارسال متن آزاد، شماره خط فعال SMS.ir لازم است؛ برای تست قالب از دکمه «ارسال تست» همان مرحله استفاده کنید.');
    if(provider==='ippanel'&&!effectiveIPPanel(await storedIPPanel(this.database.pool))?.sender)throw new ServiceUnavailableException('برای ارسال از IPPanel، شمارهٔ فرستندهٔ فعال حساب را تنظیم کنید.');
    const saved = await this.database.pool.query(`INSERT INTO sms_messages(id,recipient,message,status,provider,created_by)
      VALUES($1,$2,$3,'queued',$4,$5) RETURNING id,recipient,message,status,provider,provider_message_id,response_code,attempts,created_at`,
      [randomUUID(),recipient,message,provider,account.id]);
    return saved.rows[0];
  }

  @Post('test-stage')
  async sendStageTest(@Req() request:RequestHeaders,@Body() body?:MachineInput){
    requireMutationHeader(request);
    const account=await this.auth.access(request,'sms',2);
    const recent=await this.database.pool.query('SELECT count(*)::int AS total FROM sms_messages WHERE created_by=$1 AND created_at>now()-interval \'1 minute\'',[account.id]);
    if(recent.rows[0].total>=5)throw new ForbiddenException('در هر دقیقه حداکثر پنج پیامک مجاز است.');
    const recipient=normalizedSmsPhone(inputText(body?.recipient,30,true));
    if(!/^09\d{9}$/.test(recipient))throw new BadRequestException('شماره گیرنده معتبر نیست.');
    const stageId=inputText(body?.stage,80,true);
    const [settings,stages]=await Promise.all([this.database.pool.query("SELECT payload->'smsRules' AS rules FROM app_settings WHERE singleton"),configuredStages(this.database.pool)]);
    const stage=stages.find(item=>item.id===stageId);if(!stage)throw new BadRequestException('مرحله نامعتبر است.');
    const rule=smsRuleFor(settings.rows[0]?.rules,stage);
    if(!rule.pattern)throw new BadRequestException('برای این مرحله کد پترن را در تنظیمات پیامک ثبت کنید.');
    const variables:Record<string,string>={'ماشین':'کامیون ۱۲','پلاک':'۱۲الف۳۴۵','خرابی':'نمونه خرابی','مرحله':stage.label,'تاریخ':new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium'}).format(new Date()),'ساعت':'۱۰:۳۰','ثبت‌کننده':account.name,'تعمیرگاه':'تعمیرگاه مرکزی','قطعه':'پمپ آب','تحویل قطعه':'۱۴۰۵/۰۸/۲۴','نتیجه تست':'قبول','توضیح':'ارسال آزمایشی'};
    const message=renderSmsTemplate(rule.text,variables).slice(0,1000);
    const stored=await storedSmsIr(this.database.pool);const provider=selectedSmsProvider(stored);
    const configured=provider==='ippanel'?effectiveIPPanel(await storedIPPanel(this.database.pool)):effectiveSmsIr(stored);
    if(!smsProviderConfigured(provider,configured))throw new ServiceUnavailableException('پنل پیامک پیکربندی نشده است.');
    if(provider==='ippanel'&&(!rule.pattern.ippanelCode||!effectiveIPPanel(await storedIPPanel(this.database.pool))?.sender))throw new BadRequestException('کد پترن و شمارهٔ فرستندهٔ IPPanel باید تنظیم شود.');
    if(provider==='smsir'&&!rule.pattern.templateId)throw new BadRequestException('شناسهٔ پترن SMS.ir برای این مرحله ثبت نشده است.');
    const values=Object.fromEntries(Object.entries(rule.pattern.bindings).map(([name,key])=>[name,String(variables[key]??'').slice(0,100)]));
    const pattern=provider==='ippanel'?{code:rule.pattern.ippanelCode,parameters:values}
      :{templateId:rule.pattern.templateId!,parameters:Object.entries(values).map(([name,value])=>({name,value}))};
    const saved=await this.database.pool.query(`INSERT INTO sms_messages(id,recipient,message,status,provider,created_by,smsir_pattern) VALUES($1,$2,$3,'queued',$4,$5,$6) RETURNING id,recipient,message,status,provider,created_at`,[randomUUID(),recipient,message,provider,account.id,JSON.stringify(pattern)]);
    return saved.rows[0];
  }

  @Post('otp/test')
  async sendOtpTest(@Req() request:RequestHeaders,@Body() body?:MachineInput){
    requireMutationHeader(request);
    const account=await this.auth.access(request,'sms',2);
    const recent=await this.database.pool.query('SELECT count(*)::int AS total FROM sms_messages WHERE created_by=$1 AND created_at>now()-interval \'1 minute\'',[account.id]);
    if(recent.rows[0].total>=5)throw new ForbiddenException('در هر دقیقه حداکثر پنج پیامک مجاز است.');
    const recipient=normalizedSmsPhone(inputText(body?.recipient,30,true));
    if(!/^09\d{9}$/.test(recipient))throw new BadRequestException('شماره گیرنده معتبر نیست.');
    const stored=await storedSmsIr(this.database.pool);
    if(!stored?.enabled||stored.provider!=='ippanel')throw new ServiceUnavailableException('ابتدا IPPanel را در تنظیمات انتخاب و ارسال واقعی را فعال کنید.');
    const panelConfig=effectiveIPPanel(await storedIPPanel(this.database.pool));
    if(!panelConfig?.apiKey||!panelConfig.sender)throw new ServiceUnavailableException('کلید API و شماره فرستنده IPPanel باید تنظیم شود.');
    if(!stored.ippanel_login_pattern_code)throw new ServiceUnavailableException('کد پترن فعال OTP را در تنظیمات IPPanel ثبت کنید.');
    const code=String(randomInt(100000,1000000));
    const parameters:Record<string,string>={[stored.ippanel_code_parameter||'CODE']:code};
    if(stored.ippanel_name_parameter)parameters[stored.ippanel_name_parameter]=account.name.slice(0,25);
    const pattern:IPPanelPattern={code:stored.ippanel_login_pattern_code,parameters};
    const saved=await this.database.pool.query(`INSERT INTO sms_messages(id,recipient,message,status,provider,created_by,smsir_pattern)
      VALUES($1,$2,$3,'queued','ippanel',$4,$5) RETURNING id,recipient,message,status,provider,created_at`,
      [randomUUID(),recipient,'آزمایش ورود با کد یک‌بارمصرف',account.id,JSON.stringify(pattern)]);
    return saved.rows[0];
  }
}

@Controller('legacy-workspace')
class LegacyWorkspaceController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  private async admin(request: RequestHeaders) {
    const account = await this.auth.current(request);
    if (!account.is_super_admin) throw new ForbiddenException();
    return { id: account.id, name: account.name };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Req() request: RequestHeaders) {
    const account = await this.admin(request);
    const result = await this.database.pool.query('SELECT revision, payload FROM legacy_workspace WHERE singleton');
    return { account, revision: result.rows[0]?.revision ?? 0, payload: result.rows[0]?.payload ?? null };
  }

  @Get('migration-preview')
  @Header('Cache-Control', 'no-store')
  async migrationPreview(@Req() request: RequestHeaders) {
    const account=await this.admin(request);
    const workspace=await this.database.pool.query('SELECT revision,payload FROM legacy_workspace WHERE singleton');
    const row=workspace.rows[0];
    if(!row?.payload)return {hasSource:false,canImport:false,revision:row?.revision??0,counts:null,issues:['هنوز پشتیبان نسخهٔ قدیمی روی سرور بارگذاری نشده است.']};
    let data,inspection;
    try { data=legacyData(row.payload);inspection=inspectLegacyData(data);legacyStages(data); }
    catch(error) { return {hasSource:true,canImport:false,revision:row.revision,counts:null,issues:[error instanceof Error?error.message:'پشتیبان قابل بررسی نیست.']}; }
    const [target,batch,models,people,machines]=await Promise.all([
      this.database.pool.query(`SELECT (SELECT count(*)::int FROM repairs) AS repairs,(SELECT count(*)::int FROM analyses) AS analyses,
        (SELECT count(*)::int FROM model_parts) AS parts,(SELECT count(*)::int FROM part_logs) AS part_logs,
        (SELECT count(*)::int FROM odometer_logs) AS odometer_logs`),
      this.database.pool.query('SELECT imported_at FROM legacy_import_batches ORDER BY imported_at DESC LIMIT 1'),
      this.database.pool.query('SELECT id,name FROM machine_models'),
      this.database.pool.query('SELECT id,name,role FROM people'),
      this.database.pool.query('SELECT id,code,floating_driver FROM machines'),
    ]);
    const issues=[...inspection.issues];
    const sourceModels=new Map(data.models.map(item=>[String(item.id),String(item.name??'')]));
    const sourcePeople=new Map(data.people.map(item=>[String(item.id),{name:String(item.name??''),role:String(item.role??'')} ]));
    const sourceMachines=new Map(data.machines.map(item=>[String(item.id),{code:String(item.code??''),floating:legacyFloatingDriver(item)}]));
    for(const item of models.rows)if(sourceModels.has(item.id)&&sourceModels.get(item.id)!==item.name)issues.push(`مدل موجود با شناسهٔ «${item.id}» با نسخهٔ پشتیبان تفاوت دارد.`);
    for(const item of people.rows)if(sourcePeople.has(item.id)&&(sourcePeople.get(item.id)?.name!==item.name||sourcePeople.get(item.id)?.role!==item.role))issues.push(`پرسنل موجود با شناسهٔ «${item.id}» با نسخهٔ پشتیبان تفاوت دارد.`);
    for(const item of machines.rows){const source=sourceMachines.get(item.id);if(source&&(source.code!==item.code||source.floating!==item.floating_driver))issues.push(`ماشین موجود با شناسهٔ «${item.id}» با نسخهٔ پشتیبان تفاوت دارد.`);}
    const operational=target.rows[0];
    if(Object.values(operational).some(value=>Number(value)>0))issues.push('جدول‌های عملیاتی خالی نیستند؛ برای جلوگیری از ادغام ناسازگار، ورود خودکار فعال نمی‌شود.');
    if(batch.rows[0])issues.push(`یک نسخهٔ قدیمی قبلاً در ${new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium',timeZone:'Asia/Tehran'}).format(new Date(batch.rows[0].imported_at))} وارد جداول عملیاتی شده است.`);
    const countsHash=createHash('sha256').update(JSON.stringify(row.payload)).digest('hex');
    return {hasSource:true,canImport:issues.length===0,revision:row.revision,counts:inspection.counts,target:operational,
      directory:{models:models.rowCount,people:people.rowCount,machines:machines.rowCount},issues:[...new Set(issues)],fingerprint:countsHash,checkedBy:account.name};
  }

  @Post('import-operations')
  async importOperations(@Req() request:RequestHeaders,@Body() body?:MachineInput){
    requireMutationHeader(request);
    const account=await this.admin(request),revision=body?.revision;
    if(typeof revision!=='number'||!Number.isInteger(revision)||revision<1)throw new BadRequestException('نسخهٔ پشتیبان معتبر نیست.');
    const client=await this.database.pool.connect();
    try{
      await client.query('BEGIN');
      const source=await client.query('SELECT revision,payload FROM legacy_workspace WHERE singleton FOR UPDATE');
      if(!source.rowCount||source.rows[0].revision!==revision)throw new ConflictException('پشتیبان در همین حین تغییر کرده؛ پیش‌نمایش را تازه کنید.');
      const payload=source.rows[0].payload;
      const data=legacyData(payload),issues=inspectLegacyData(data).issues;
      legacyStages(data);
      if(issues.length)throw new BadRequestException(issues.join('\n'));
      const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const prior=await client.query('SELECT counts,imported_at FROM legacy_import_batches WHERE fingerprint=$1',[fingerprint]);
      if(prior.rowCount){await client.query('COMMIT');return {alreadyImported:true,counts:prior.rows[0].counts,imported_at:prior.rows[0].imported_at};}
      const existing=await client.query(`SELECT (SELECT count(*)::int FROM repairs) AS repairs,(SELECT count(*)::int FROM analyses) AS analyses,
        (SELECT count(*)::int FROM model_parts) AS parts,(SELECT count(*)::int FROM part_logs) AS part_logs,
        (SELECT count(*)::int FROM odometer_logs) AS odometer_logs`);
      const models=await client.query('SELECT id,name FROM machine_models');
      const people=await client.query('SELECT id,name,role FROM people');
      const machines=await client.query('SELECT id,code,floating_driver FROM machines');
      if(Object.values(existing.rows[0]).some(value=>Number(value)>0))throw new ConflictException('جداول عملیاتی باید برای ورود اول خالی باشند.');
      const byModel=new Map(data.models.map(item=>[String(item.id),String(item.name??'')]));
      const byPerson=new Map(data.people.map(item=>[String(item.id),{name:String(item.name??''),role:String(item.role??'')} ]));
      const byMachine=new Map(data.machines.map(item=>[String(item.id),{code:String(item.code??''),floating:legacyFloatingDriver(item)}]));
      if(models.rows.some(item=>byModel.has(item.id)&&byModel.get(item.id)!==item.name)
        ||people.rows.some(item=>byPerson.has(item.id)&&(byPerson.get(item.id)?.name!==item.name||byPerson.get(item.id)?.role!==item.role))
        ||machines.rows.some(item=>{const source=byMachine.get(item.id);return source&&(source.code!==item.code||source.floating!==item.floating_driver);}))throw new ConflictException('رکورد پایه‌ای با شناسهٔ مشترک اما اطلاعات متفاوت پیدا شد؛ ورود انجام نشد.');
      const counts=await importLegacyOperations(client,payload,account.id);
      await client.query('INSERT INTO legacy_import_batches(fingerprint,source_revision,counts,imported_by) VALUES($1,$2,$3,$4)',[fingerprint,revision,counts,account.id]);
      await client.query('COMMIT');
      return {alreadyImported:false,counts};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  @Put()
  async put(@Req() request: RequestHeaders, @Body() body?: { revision?: unknown; payload?: unknown }) {
    requireMutationHeader(request);
    await this.admin(request);
    const { revision, payload } = body ?? {};
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || revision >= 2147483647
      || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new BadRequestException();
    const data = { ...(payload as Record<string, unknown>) };
    if (data.schema !== 4 || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)
      || !['people', 'machines', 'models', 'analyses', 'partLogs', 'odoLogs', 'repairs'].every(key => Array.isArray(data[key]))) {
      throw new BadRequestException('Invalid workspace');
    }
    delete data.users;
    data.settings = { ...(data.settings as Record<string, unknown>), sms: {} };
    const settings = data.settings as Record<string, unknown>;
    const normalized = {
      companyName: typeof settings.companyName === 'string' ? settings.companyName.slice(0, 180) : 'شرکت دام و طیور سپید بستک',
      orgName: typeof settings.orgName === 'string' ? settings.orgName.slice(0, 120) : 'واحد ماشین‌آلات',
      theme: ['auto','light','dark'].includes(String(settings.theme)) ? settings.theme : 'auto',
      warnPercent: Number.isInteger(settings.warnPercent) && Number(settings.warnPercent) >= 1 && Number(settings.warnPercent) <= 100 ? settings.warnPercent : 10,
      countWindow: ['all','year','12m'].includes(String(settings.countWindow)) ? settings.countWindow : 'all',
      backupRemindDays: Number.isInteger(settings.backupRemindDays) && Number(settings.backupRemindDays) >= 1 && Number(settings.backupRemindDays) <= 365 ? settings.backupRemindDays : 7,
    };
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = revision === 0
        ? await client.query('INSERT INTO legacy_workspace(payload) VALUES($1) ON CONFLICT DO NOTHING RETURNING revision', [data])
        : await client.query('UPDATE legacy_workspace SET payload=$1, revision=revision+1, updated_at=now() WHERE singleton AND revision=$2 RETURNING revision', [data, revision]);
      if (!result.rowCount) throw new ConflictException();
      await client.query('UPDATE app_settings SET payload=payload || $1::jsonb,revision=revision+1,updated_at=now() WHERE singleton', [normalized]);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

@Controller('analyses')
class AnalysesController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  @Delete(':id')
  async remove(@Req() request: RequestHeaders, @Param('id', ParseUUIDPipe) id: string) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'analyses', 3);
    if (account.scope_shop) throw new ForbiddenException();
    const result = await this.database.pool.query('DELETE FROM analyses WHERE id=$1 RETURNING id', [id]);
    if (!result.rowCount) throw new NotFoundException('تحلیل پیدا نشد.');
    return { deleted: true };
  }

  @Get('options')
  @Header('Cache-Control', 'no-store')
  async options(@Req() request: RequestHeaders) {
    const account=await this.auth.access(request, 'analyses', 1);
    const [machines, people, workspace, settings] = await Promise.all([
      this.database.pool.query(`SELECT m.id,m.code,m.plate,m.type,model.name AS model_name,m.active,m.driver_id,m.supervisor_id,m.pm_id,m.floating_driver
        FROM machines m LEFT JOIN machine_models model ON model.id=m.model_id ORDER BY m.sort_order,m.id`),
      this.database.pool.query("SELECT id,name,role FROM people WHERE active AND role IN ('driver','supervisor','pm') ORDER BY name,id"),
      this.database.pool.query('SELECT payload->\'rules\' AS rules FROM legacy_workspace WHERE singleton'),
      this.database.pool.query("SELECT payload->>'countWindow' AS count_window,payload->'analysisRules' AS rules FROM app_settings WHERE singleton"),
    ]);
    const permissions=await this.auth.permissions(account);
    const stages=account.scope_shop?(await configuredStages(this.database.pool)).filter(stage=>stage.kind==='step').map(stage=>stage.id):null;
    const repairs=(permissions.repairs??0)>=1?await this.database.pool.query(`SELECT r.id,r.machine_id,r.number,r.title,r.stage,r.result
      FROM repairs r WHERE $1::text[] IS NULL OR r.stage=ANY($1::text[]) ORDER BY r.number DESC`,[stages]):{rows:[]};
    const defaultRules = {
      driver: { low: [{min:1,max:5,action:'تعهد کتبی'},{min:6,max:7,action:'کسر پاداش'},{min:8,max:null,action:'کسر حقوق'}],
        mid: [{min:1,max:5,action:'کسر پاداش'},{min:6,max:null,action:'کسر حقوق'}], high: [{min:1,max:1,action:'تعهد کتبی و کسر پاداش'},{min:2,max:null,action:'کسر حقوق'}] },
      pm: { low: [{min:1,max:5,action:'تعهد کتبی'},{min:6,max:7,action:'کسر پاداش'},{min:8,max:null,action:'کسر حقوق'}],
        mid: [{min:1,max:5,action:'کسر پاداش'},{min:6,max:null,action:'کسر حقوق'}], high: [{min:1,max:1,action:'تعهد کتبی و کسر پاداش'},{min:2,max:null,action:'کسر حقوق'}] },
    };
    return { machines: machines.rows, people: people.rows, repairs:repairs.rows, rules: settings.rows[0]?.rules ?? workspace.rows[0]?.rules ?? defaultRules,
      countWindow: settings.rows[0]?.count_window ?? 'all' };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: RequestHeaders) {
    const account=await this.auth.access(request, 'analyses', 1);
    const permissions=await this.auth.permissions(account);
    const canSeeRepairs=account.is_super_admin||(permissions.repairs??0)>=1;
    const stages=account.scope_shop?(await configuredStages(this.database.pool)).filter(stage=>stage.kind==='step').map(stage=>stage.id):null;
    return (await this.database.pool.query(`SELECT a.id,a.analysis_date::text,a.machine_id,m.code AS machine_code,
      a.topic,a.cause,a.severity,a.responses,a.goldratt,a.note,a.created_at,
      (a.repair_id IS NOT NULL) AS has_repair_link,
      CASE WHEN $1 AND ($2::text[] IS NULL OR linked.stage=ANY($2::text[])) THEN linked.id END AS repair_id,
      CASE WHEN $1 AND ($2::text[] IS NULL OR linked.stage=ANY($2::text[])) THEN linked.number END AS repair_number,
      CASE WHEN $1 AND ($2::text[] IS NULL OR linked.stage=ANY($2::text[])) THEN linked.title END AS repair_title
      FROM analyses a JOIN machines m ON m.id=a.machine_id LEFT JOIN repairs linked ON linked.id=a.repair_id
      ORDER BY a.analysis_date DESC,a.id DESC`,[canSeeRepairs,stages])).rows;
  }

  private async linkedRepair(request:RequestHeaders,machineId:string,raw:unknown):Promise<string|null>{
    if(raw===undefined||raw===null||raw==='')return null;
    if(typeof raw!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(raw))throw new BadRequestException();
    const account=await this.auth.access(request,'repairs',1);
    const stages=account.scope_shop?(await configuredStages(this.database.pool)).filter(stage=>stage.kind==='step').map(stage=>stage.id):null;
    const result=await this.database.pool.query('SELECT 1 FROM repairs WHERE id=$1 AND machine_id=$2 AND ($3::text[] IS NULL OR stage=ANY($3::text[]))',[raw,machineId,stages]);
    if(!result.rowCount)throw new NotFoundException();
    return raw;
  }

  @Post()
  async create(@Req() request: RequestHeaders, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    const account = await this.auth.access(request, 'analyses', 2);
    const machineId=inputText(body?.machine_id,100,true);
    const repairId=await this.linkedRepair(request,machineId,body?.repair_id);
    const severity = body?.severity;
    if (!['low','medium','high','critical'].includes(String(severity))) throw new BadRequestException();
    const responses = body?.responses ?? {};
    const goldratt = body?.goldratt ?? {};
    if (!responses || typeof responses !== 'object' || Array.isArray(responses)
      || !goldratt || typeof goldratt !== 'object' || Array.isArray(goldratt)) throw new BadRequestException();
    const result = await this.database.pool.query(
      `WITH created AS (
         INSERT INTO analyses(id,machine_id,analysis_date,topic,cause,severity,responses,goldratt,note,created_by,repair_id)
         SELECT $1,m.id,$3,$4,$5,$6,$7,$8,$9,$10,$11 FROM machines m WHERE m.id=$2
         RETURNING id,analysis_date,machine_id,topic,cause,severity,responses,goldratt,note,created_at,repair_id
       ) SELECT created.id,created.analysis_date::text,created.machine_id,m.code AS machine_code,created.topic,created.cause,
           created.severity,created.responses,created.goldratt,created.note,created.created_at,created.repair_id,(created.repair_id IS NOT NULL) AS has_repair_link
         FROM created JOIN machines m ON m.id=created.machine_id`,
      [randomUUID(),machineId,calendarDate(body?.date),
        inputText(body?.topic,500,true),inputText(body?.cause,4000),severity, responses,
        goldratt,inputText(body?.note,4000),account.id,repairId],
    );
    if (!result.rowCount) throw new NotFoundException();
    return result.rows[0];
  }

  @Patch(':id')
  async update(@Req() request:RequestHeaders,@Param('id',ParseUUIDPipe) id:string,@Body() body?:MachineInput){
    requireMutationHeader(request);
    await this.auth.access(request,'analyses',2);
    const machineId=inputText(body?.machine_id,100,true);
    const hasRepairId=Object.hasOwn(body??{},'repair_id');
    if(hasRepairId)await this.auth.access(request,'repairs',1);
    const repairId=hasRepairId?await this.linkedRepair(request,machineId,body?.repair_id):null;
    const severity=body?.severity;
    const responses=body?.responses??{};
    const goldratt=body?.goldratt??{};
    if(!['low','medium','high','critical'].includes(String(severity))
      ||!responses||typeof responses!=='object'||Array.isArray(responses)
      ||!goldratt||typeof goldratt!=='object'||Array.isArray(goldratt))throw new BadRequestException();
    const result=await this.database.pool.query(`UPDATE analyses a SET machine_id=m.id,analysis_date=$3,topic=$4,cause=$5,
      severity=$6,responses=$7,goldratt=$8,note=$9,repair_id=CASE WHEN $10 THEN $11::uuid ELSE a.repair_id END FROM machines m WHERE a.id=$1 AND m.id=$2
      RETURNING a.id,a.analysis_date::text,a.machine_id,m.code AS machine_code,a.topic,a.cause,a.severity,
        a.responses,a.goldratt,a.note,a.created_at,a.repair_id,
        (a.repair_id IS NOT NULL) AS has_repair_link`,
      [id,machineId,calendarDate(body?.date),inputText(body?.topic,500,true),inputText(body?.cause,4000),
        severity,responses,goldratt,inputText(body?.note,4000),hasRepairId,repairId]);
    if(!result.rowCount)throw new NotFoundException();
    return result.rows[0];
  }
}

@Controller('settings')
class SettingsController {
  constructor(private readonly database: Database, private readonly auth: Auth) {}

  @Get('brand')
  @Header('Cache-Control', 'no-store')
  async brand() {
    const result = await this.database.pool.query("SELECT payload->>'companyName' AS company_name, payload->>'orgName' AS org_name, payload->>'theme' AS theme FROM app_settings WHERE singleton");
    return { companyName: result.rows[0]?.company_name ?? 'شرکت دام و طیور سپید بستک', orgName: result.rows[0]?.org_name ?? 'واحد ماشین‌آلات', theme: result.rows[0]?.theme ?? 'auto' };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Req() request: RequestHeaders) {
    await this.auth.access(request, 'settings', 2);
    const result = await this.database.pool.query(`SELECT revision,
      payload || CASE WHEN payload ? 'analysisRules' THEN '{}'::jsonb
        WHEN (SELECT payload->'rules' FROM legacy_workspace WHERE singleton) IS NOT NULL
          THEN jsonb_build_object('analysisRules',(SELECT payload->'rules' FROM legacy_workspace WHERE singleton))
        ELSE '{}'::jsonb END AS payload,updated_at FROM app_settings WHERE singleton`);
    return result.rows[0];
  }

  @Put()
  async update(@Req() request: RequestHeaders, @Body() body?: MachineInput) {
    requireMutationHeader(request);
    await this.auth.access(request, 'settings', 2);
    const revision = body?.revision;
    const warnPercent = body?.warnPercent;
    const countWindow = body?.countWindow;
    const backupRemindDays = body?.backupRemindDays;
    const smsStageAlerts = body?.smsStageAlerts;
    const analysisRules = body?.analysisRules;
    const stages = body?.stages;
    const orgName = body?.orgName;
    const theme = body?.theme;
    if (!Number.isInteger(revision) || Number(revision) < 1 || !Number.isInteger(warnPercent)
      || Number(warnPercent) < 1 || Number(warnPercent) > 100 || !['all','year','12m'].includes(String(countWindow)) || !Number.isInteger(backupRemindDays)
      || Number(backupRemindDays) < 1 || Number(backupRemindDays) > 365 || typeof smsStageAlerts !== 'boolean'
      || (theme !== undefined && (typeof theme !== 'string' || !['auto','light','dark'].includes(theme)))) throw new BadRequestException();
    let normalizedStages: StageDefinition[] | undefined;
    if (stages !== undefined) {
      if (!Array.isArray(stages) || stages.length < 2 || stages.length > 12) throw new BadRequestException('Invalid repair stages');
      normalizedStages = stages.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid repair stage');
        const item = value as Record<string, unknown>;
        const id = inputText(item.id, 40, true);
        const label = inputText(item.label, 60, true);
        const kind = item.kind;
        if (!/^[a-z][a-z0-9_-]{1,39}$/.test(id)
          || (index === 0 ? id !== 'report' || kind !== 'report' : index === stages.length - 1 ? id !== 'test' || kind !== 'test' : kind !== 'step')) {
          throw new BadRequestException('Stages must begin with report, end with test, and use steps between them');
        }
        const limit = item.limit === undefined ? null : item.limit;
        const mode=item.mode??(id==='report'?'report':id==='test'?'test':id==='wait'?'wait':id==='done'?'done':'step');
        const loc=item.loc??(mode==='report'?'factory':mode==='wait'?'part':mode==='done'?'shop':mode==='test'?'done':'shop');
        const who=inputText(item.who,80);
        const desc=inputText(item.desc,500);
        if (limit !== null && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 365)) {
          throw new BadRequestException('Stage limit must be between 1 and 365 days');
        }
        if(!['report','step','wait','done','test'].includes(String(mode))||(index===0?mode!=='report':index===stages.length-1?mode!=='test':!['step','wait','done'].includes(String(mode))))throw new BadRequestException('Invalid repair stage operation');
        if(!['factory','road','shop','part','done'].includes(String(loc)))throw new BadRequestException('Invalid repair stage location');
        return { id, label, kind: kind as StageDefinition['kind'], mode:mode as StageDefinition['mode'], loc:loc as StageDefinition['loc'], who, desc, limit: index === 0 || index === stages.length - 1 ? null : limit as number | null };
      });
      if (new Set(normalizedStages.map(item => item.id)).size !== normalizedStages.length) throw new BadRequestException('Duplicate repair stage');
      const used = await this.database.pool.query<{ stage: string }>(
        `SELECT used.stage_id FROM repairs r CROSS JOIN LATERAL unnest(r.workflow) AS used(stage_id)
         WHERE used.stage_id <> ALL($1::text[]) LIMIT 1`, [normalizedStages.map(item=>item.id)],
      );
      if (used.rowCount) throw new BadRequestException('مرحله‌ای که در گردش یک پروندهٔ موجود استفاده شده باشد، قابل حذف نیست.');
    }
    let normalizedRules: unknown;
    if (analysisRules !== undefined) {
      if (!analysisRules || typeof analysisRules !== 'object' || Array.isArray(analysisRules)) throw new BadRequestException('Invalid analysis rules');
      const output: Record<string,Record<string,{min:number;max:number|null;action:string}[]>> = {};
      for (const role of ['driver','pm']) {
        const bySeverity=(analysisRules as Record<string,unknown>)[role];
        if (!bySeverity || typeof bySeverity !== 'object' || Array.isArray(bySeverity)) throw new BadRequestException('Invalid analysis rules');
        output[role]={};
        for (const severity of ['low','mid','high']) {
          const rows=(bySeverity as Record<string,unknown>)[severity];
          if (!Array.isArray(rows) || rows.length>20) throw new BadRequestException('Invalid analysis rules');
          let previousMax=0;
          output[role][severity]=rows.map(row=>{
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw new BadRequestException('Invalid analysis rule');
            const {min,max}=row as {min?:unknown;max?:unknown};
            if (!Number.isSafeInteger(min)||Number(min)<1 || (max!==null&&(!Number.isSafeInteger(max)||Number(max)<Number(min))) || Number(min)<=previousMax) throw new BadRequestException('Invalid analysis rule range');
            previousMax=max===null?Number.MAX_SAFE_INTEGER:Number(max);
            return {min:Number(min),max:max===null?null:Number(max),action:inputText((row as Record<string,unknown>).action,200,true)};
          });
        }
      }
      normalizedRules=output;
    }
    const payload:Record<string,unknown> = { companyName: inputText(body?.companyName, 180, true), orgName: inputText(orgName === undefined ? 'واحد ماشین‌آلات' : orgName, 120), theme: theme === undefined ? 'auto' : theme, warnPercent, countWindow, backupRemindDays, smsStageAlerts };
    if(normalizedRules!==undefined)payload.analysisRules=normalizedRules;
    if(normalizedStages!==undefined)payload.stages=normalizedStages;
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const previousStageIds=normalizedStages?new Set((await client.query<{stages:StageDefinition[]|null}>("SELECT payload->'stages' AS stages FROM app_settings WHERE singleton FOR UPDATE")).rows[0]?.stages?.map(stage=>stage.id)??[]):new Set<string>();
      const result = await client.query(
        'UPDATE app_settings SET payload=payload || $1::jsonb,revision=revision+1,updated_at=now() WHERE singleton AND revision=$2 RETURNING revision,payload,updated_at', [payload, revision],
      );
      if (!result.rowCount) throw new ConflictException();
      if(normalizedStages)for(let index=1;index<normalizedStages.length-1;index++){
        const stage=normalizedStages[index];if(previousStageIds.has(stage.id))continue;
        const previous=normalizedStages[index-1];
        await client.query(`INSERT INTO user_stage_permissions(user_id,stage)
          SELECT user_id,$2 FROM user_stage_permissions WHERE stage=$1 ON CONFLICT(user_id,stage) DO NOTHING`,[previous.id,stage.id]);
      }
      await client.query(
        `INSERT INTO legacy_workspace(singleton,revision,payload)
         VALUES(true,1,jsonb_build_object('schema',4,'settings',$1::jsonb))
         ON CONFLICT(singleton) DO UPDATE SET
           payload=jsonb_set(COALESCE(legacy_workspace.payload,'{}'::jsonb),'{settings}',
             COALESCE(legacy_workspace.payload->'settings','{}'::jsonb) || $1::jsonb,true),
           revision=legacy_workspace.revision+1,updated_at=now()`, [payload],
      );
      if(normalizedRules!==undefined)await client.query(
        `UPDATE legacy_workspace SET payload=jsonb_set(payload,'{rules}',$1::jsonb,true),revision=revision+1,updated_at=now() WHERE singleton`, [normalizedRules],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

@Controller('health')
class HealthController {
  constructor(private readonly database: Database) {}

  @Get()
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.database.checkReady();
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('Service unavailable');
    }
  }
}

@Controller()
class ApiDocumentationController {
  @Get('openapi.json')
  @Header('Cache-Control', 'public, max-age=300')
  document() {
    return openApiDocument;
  }
}

@Controller('backups')
class BackupsController {
  constructor(private readonly auth: Auth) {}

  private async directory(request: RequestHeaders): Promise<string> {
    const account = await this.auth.current(request);
    if (!account.is_super_admin) throw new ForbiddenException();
    return resolve(process.env.BACKUP_DIRECTORY ?? './backups');
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: RequestHeaders) {
    const directory = await this.directory(request);
    try {
      const names = await readdir(directory);
      const files = await Promise.all(names.filter(name => /^sepid-\d{8}T\d{6}Z\.dump$/.test(name)).map(async name => {
        const info = await lstat(join(directory, name));
        return info.isFile() ? { name, size: info.size, createdAt: info.mtime.toISOString() } : null;
      }));
      return files.filter((file): file is NonNullable<typeof file> => file !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new ServiceUnavailableException('Backup storage unavailable');
    }
  }

  @Get(':filename')
  @Header('Cache-Control', 'no-store')
  async download(@Req() request: RequestHeaders, @Param('filename') filename: string) {
    const directory = await this.directory(request);
    if (!/^sepid-\d{8}T\d{6}Z\.dump$/.test(filename)) throw new NotFoundException();
    const path = join(directory, filename);
    try {
      const info = await lstat(path);
      if (!info.isFile()) throw new NotFoundException();
      return new StreamableFile(createReadStream(path), {
        type: 'application/octet-stream',
        disposition: `attachment; filename="${filename}"`,
        length: info.size,
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException();
      throw new ServiceUnavailableException('Backup storage unavailable');
    }
  }
}

@Module({
  controllers: [HealthController, ApiDocumentationController, AuthController, UsersController, MachinesController, DirectoryController, RepairsController, StatusController, MaintenanceController, PartsController, DashboardController, ReportsController, SmsController, LegacyWorkspaceController, AnalysesController, SettingsController, BackupsController],
  providers: [Database, Auth],
})
class AppModule {}

async function main(): Promise<void> {
  if (process.argv.includes('--bootstrap-admin')) {
    const context = await NestFactory.createApplicationContext(AppModule);
    try { await context.get(Auth).bootstrap(); } finally { await context.close(); }
    return;
  }
  if (process.argv.includes('--worker')) {
    const context = await NestFactory.createApplicationContext(AppModule);
    context.enableShutdownHooks();
    return;
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '5mb' });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.get(Auth).bootstrap();
  await app.listen(Number(process.env.PORT ?? '55320'), process.env.HOST ?? '127.0.0.1');
}

void main();
