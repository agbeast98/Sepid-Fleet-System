export type SmsIrConfig = { apiKey: string; lineNumber: number | null };

export function smsIrConfig(): SmsIrConfig | null {
  const apiKey = process.env.SMSIR_API_KEY?.trim();
  const line = process.env.SMSIR_LINE_NUMBER?.trim() ?? '';
  const lineNumber = Number(line);
  return apiKey && /^[1-9]\d*$/.test(line) && Number.isSafeInteger(lineNumber)
    ? { apiKey, lineNumber }
    : null;
}

export function smsProviderConfigured(provider: string, config: { apiKey?:string; lineNumber?:number|null; sender?:string } | null = smsIrConfig()): boolean {
  if (provider === 'smsir') return config !== null && !!config.apiKey;
  if (provider === 'ippanel') return !!config?.apiKey && !!config.sender;
  if (provider === 'kavenegar') return !!process.env.KAVENEGAR_API_KEY && !!process.env.KAVENEGAR_SENDER;
  return provider === 'mock';
}

export async function smsIrDelivery(messageId: string, apiKey = smsIrConfig()?.apiKey) {
  if (!apiKey || !/^[1-9]\d{0,29}$/.test(messageId)) return null;
  try {
    const response = await fetch(`https://api.sms.ir/v1/send/${messageId}`, {
      headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (!response.ok) return null;
    const result = await response.json() as { status?: number; data?: { deliveryState?: number; deliveryDateTime?: number } };
    if (result?.status !== 1 || !result.data) return null;
    const { deliveryState, deliveryDateTime } = result.data;
    return {
      state: Number.isInteger(deliveryState) ? Number(deliveryState) : null,
      time: typeof deliveryDateTime === 'number' && deliveryDateTime > 0 && deliveryDateTime < 253402300800
        ? new Date(deliveryDateTime * 1000).toISOString() : null,
    };
  } catch {
    return null;
  }
}

type SendResult = {
  status: 'accepted' | 'failed' | 'unconfirmed';
  providerId: string;
  responseCode: number | null;
};

export type SmsIrPattern = { templateId: number; parameters: { name: string; value: string }[] };

export async function sendSmsIr(recipient: string, messageText: string, config = smsIrConfig(), pattern?: SmsIrPattern): Promise<SendResult> {
  const mobile = recipient.replace(/^(?:\+98|0098|0)?(?=9\d{9}$)/, '0');
  if (!config || !/^09\d{9}$/.test(mobile) || (!pattern && !config.lineNumber)) {
    return { status: 'failed', providerId: '', responseCode: null };
  }
  let responseCode: number | null = null;
  try {
    const response = await fetch(pattern ? 'https://api.sms.ir/v1/send/verify' : 'https://api.sms.ir/v1/send/bulk', {
      method: 'POST',
      headers: { 'X-API-KEY': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(pattern ? { mobile, ...pattern } : { lineNumber: config.lineNumber, messageText, mobiles: [mobile], sendDateTime: null }),
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    responseCode = response.status;
    const result = await response.json() as { status?: number; data?: { messageIds?: (number | string)[]; messageId?: number | string } };
    if (Number.isInteger(result?.status)) responseCode = Number(result.status);
    const id = pattern ? result?.data?.messageId : result?.data?.messageIds?.[0];
    const providerId = typeof id === 'string' && /^[1-9]\d{0,29}$/.test(id)
      ? id
      : typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : '';
    if (response.ok && result?.status === 1 && providerId) return { status: 'accepted', providerId, responseCode };
    if (!providerId && response.status < 500 && Number.isInteger(result?.status) && result.status !== 1) {
      return { status: 'failed', providerId, responseCode };
    }
    return { status: 'unconfirmed', providerId, responseCode };
  } catch {
    return { status: 'unconfirmed', providerId: '', responseCode };
  }
}
