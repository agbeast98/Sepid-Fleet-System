import { createDecipheriv } from 'node:crypto';
import type { Pool } from 'pg';
import { smsEncryptionKey } from './sms-ir-settings';

export type IPPanelConfig = { apiKey: string; sender: string };
export type IPPanelPattern = { code: string; parameters: Record<string, string> };
export type IPPanelSendResult = { status: 'accepted' | 'failed' | 'unconfirmed'; providerId: string; responseCode: number | null };
export type IPPanelPatternInfo = { code: string; title: string; body: string; variables: string[] };

type StoredConfig = { ippanel_api_key_encrypted?: string | null; ippanel_sender?: string | null };

export function normalizeIPPanelSender(value: string): string {
  const normalizedDigits=value.replace(/[۰-۹٠-٩]/g,char=>String('۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩'.indexOf(char)%10));
  const compact=normalizedDigits.trim().replace(/[\s().-]/g,'');
  if(!/^\+?[0-9]+$/.test(compact))return '';
  let digits=compact.replace(/^\+/,'');
  if(digits.startsWith('0098'))digits=digits.slice(2);
  else if(digits.startsWith('0'))digits=`98${digits.slice(1)}`;
  else if(!digits.startsWith('98'))digits=`98${digits}`;
  return /^98[0-9]{5,15}$/.test(digits)?`+${digits}`:'';
}

function decryptKey(value: string, key: Buffer): string | null {
  try {
    const parts = value.split(':');
    if (parts.length !== 3 || parts.some(part => !/^[a-f0-9]+$/i.test(part))) return null;
    const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, 'hex'));
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch { return null; }
}

export async function storedIPPanel(pool: Pool): Promise<StoredConfig | undefined> {
  const result = await pool.query<StoredConfig>('SELECT ippanel_api_key_encrypted,ippanel_sender FROM sms_ir_settings WHERE singleton');
  return result.rows[0];
}

export function effectiveIPPanel(stored?: StoredConfig): IPPanelConfig | null {
  const key = smsEncryptionKey();
  const sender=normalizeIPPanelSender(stored?.ippanel_sender||process.env.IPPANEL_SENDER?.trim()||'');
  if (stored?.ippanel_api_key_encrypted) {
    if (!key) return null;
    const apiKey = decryptKey(stored.ippanel_api_key_encrypted, key);
    return apiKey && sender ? { apiKey, sender } : null;
  }
  const apiKey = process.env.IPPANEL_API_KEY?.trim() ?? '';
  return apiKey && sender ? { apiKey, sender } : null;
}

function recipientE164(value: string): string {
  let digits = value.replace(/[۰-۹٠-٩]/g, char => String('۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩'.indexOf(char) % 10)).replace(/\D/g, '');
  if (digits.startsWith('0098')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `98${digits.slice(1)}`;
  else if (digits.startsWith('9')) digits = `98${digits}`;
  return /^989\d{9}$/.test(digits) ? `+${digits}` : '';
}

function providerId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d{1,30}$/.test(value) && Number(value) > 0) return value;
  return '';
}

async function request(config: IPPanelConfig, path: string, init: RequestInit): Promise<Response> {
  return fetch(`https://edge.ippanel.com/v1${path}`, {
    ...init,
    headers: { Authorization: config.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
}

export async function sendIPPanel(recipient: string, message: string, config: IPPanelConfig | null, pattern?: IPPanelPattern): Promise<IPPanelSendResult> {
  const mobile = recipientE164(recipient);
  const sender=config?normalizeIPPanelSender(config.sender):'';
  if (!config || !mobile || !sender || (pattern && !pattern.code.trim()) || (!pattern && !message.trim())) {
    return { status: 'failed', providerId: '', responseCode: null };
  }
  try {
    const body = pattern
      ? { sending_type: 'pattern', from_number: sender, code: pattern.code, recipients: [mobile], params: pattern.parameters }
      : { sending_type: 'webservice', from_number: sender, message, params: { recipients: [mobile] } };
    const response = await request(config, '/api/send', { method: 'POST', body: JSON.stringify(body) });
    type ApiResponse={data?:{message_outbox_ids?:unknown[]};meta?:{status?:boolean}};
    let result:ApiResponse|undefined;
    try { result = await response.json() as ApiResponse; } catch { /* Provider sent no JSON response. */ }
    const id = providerId(result?.data?.message_outbox_ids?.[0]);
    if (response.ok && result?.meta?.status === true && id) return { status: 'accepted', providerId: id, responseCode: response.status };
    if (response.status < 500 && result?.meta?.status === false) return { status: 'failed', providerId: '', responseCode: response.status };
    return { status: 'unconfirmed', providerId: id, responseCode: response.status };
  } catch { return { status: 'unconfirmed', providerId: '', responseCode: null }; }
}

export async function ippanelDelivery(messageId: string, config: IPPanelConfig | null) {
  if (!config || !/^\d{1,30}$/.test(messageId)) return null;
  try {
    const query = new URLSearchParams({ messages_outbox_id: messageId });
    const response = await request(config, `/api/report/by_bulk?${query}`, { method: 'GET' });
    if (!response.ok) return null;
    const result = await response.json() as { data?: { state_id?: unknown; status?: unknown; time_send?: unknown }; meta?: { status?: boolean } };
    if (result?.meta?.status !== true || !result.data) return null;
    const state = Number(result.data.state_id);
    const rawTime = Number(result.data.time_send);
    return {
      state: Number.isInteger(state) ? state : null,
      status: typeof result.data.status === 'string' ? result.data.status : null,
      time: Number.isFinite(rawTime) && rawTime > 0 ? new Date(rawTime * 1000).toISOString() : null,
    };
  } catch { return null; }
}

export async function listIPPanelPatterns(config: IPPanelConfig | null): Promise<IPPanelPatternInfo[] | null> {
  if (!config) return null;
  try {
    const collected: IPPanelPatternInfo[] = [];
    for (let page = 1; page <= 10; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: '100', 'filter[state]': 'active' });
      const response = await request(config, `/api/patterns?${query}`, { method: 'GET' });
      if (!response.ok) return null;
      const result = await response.json() as { data?: unknown; meta?: { status?: boolean; last_page?: number } };
      if (result.meta?.status !== true || !Array.isArray(result.data)) return null;
      for (const item of result.data) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const code = typeof row.pattern_code === 'string' ? row.pattern_code : '';
        if (!code) continue;
        const variables = Array.isArray(row.variable) ? row.variable.flatMap(value => {
          if (!value || typeof value !== 'object') return [];
          const name = (value as Record<string, unknown>).name;
          return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? [name] : [];
        }) : [];
        collected.push({ code, title: typeof row.title === 'string' && row.title ? row.title : code,
          body: typeof row.pattern_message === 'string' ? row.pattern_message : '', variables });
      }
      if (page >= Number(result.meta.last_page ?? 1)) break;
    }
    return collected;
  } catch { return null; }
}
