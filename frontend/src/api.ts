export class ApiError extends Error {
  constructor(readonly status: number, readonly detail?: string) { super('Request failed'); }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers = new Headers();
  if (method !== 'GET') headers.set('X-Sepid-Request', '1');
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch('/api/v1' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let detail:string|undefined;
    try { const payload=await response.json() as {message?:unknown};detail=typeof payload.message==='string'?payload.message:Array.isArray(payload.message)?payload.message.join('، '):undefined; } catch { /* Keep the status-based message below. */ }
    throw new ApiError(response.status,detail);
  }
  return response.json() as Promise<T>;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.detail?.trim();
    if (error.status === 401 && (!detail || /^unauthorized$/i.test(detail))) return 'ورود ناموفق بود یا نشست منقضی شده است.';
    if (error.status === 403 && (!detail || /^forbidden(?: resource)?$/i.test(detail))) return 'این عملیات در دسترس نیست.';
    if(detail)return detail;
    if (error.status === 409) return 'این پرونده تغییر کرده است. فهرست را تازه‌سازی کنید.';
    if (error.status === 400) return 'مقادیر فرم را بررسی کنید.';
    if (error.status === 503) return 'سرویس پیامک پیکربندی نشده یا موقتاً در دسترس نیست.';
  }
  return 'ارتباط با سامانه برقرار نشد. دوباره تلاش کنید.';
}
