import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { smsIrConfig, type SmsIrConfig } from './sms-ir';

export function smsEncryptionKey(): Buffer | null {
  const encoded = process.env.SMS_CONFIG_ENCRYPTION_KEY ?? '';
  return /^[a-fA-F0-9]{64}$/.test(encoded) ? Buffer.from(encoded, 'hex') : null;
}

export function encryptSmsKey(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('hex')).join(':');
}

export type Stored = { api_key_encrypted: string; line_number: string | null; enabled: boolean; login_template_id: number | null; provider?: string; ippanel_api_key_encrypted?:string|null; ippanel_sender?:string|null; ippanel_login_pattern_code?:string|null; ippanel_name_parameter?:string; ippanel_code_parameter?:string };

export async function storedSmsIr(pool: Pool): Promise<Stored | undefined> {
  const result = await pool.query<Stored>(
    'SELECT api_key_encrypted,line_number,enabled,login_template_id,provider,ippanel_api_key_encrypted,ippanel_sender,ippanel_login_pattern_code,ippanel_name_parameter,ippanel_code_parameter FROM sms_ir_settings WHERE singleton',
  );
  return result.rows[0];
}

export function effectiveSmsIr(stored?: Stored): SmsIrConfig | null {
  if (!stored) return smsIrConfig();
  const key = smsEncryptionKey();
  if (!key) return null;
  try {
    const [iv, tag, encrypted] = stored.api_key_encrypted.split(':').map(part => Buffer.from(part, 'hex'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAuthTag(tag);
    const apiKey = Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
    if (!apiKey) return smsIrConfig();
    return { apiKey, lineNumber: stored.line_number && /^[1-9]\d*$/.test(stored.line_number) ? Number(stored.line_number) : null };
  } catch {
    return null;
  }
}

export function selectedSmsProvider(stored?: Stored): string {
  if (stored) return stored.enabled ? (stored.provider ?? 'smsir') : 'mock';
  return process.env.SMS_PROVIDER ?? (process.env.NODE_ENV === 'production' ? 'kavenegar' : 'mock');
}
