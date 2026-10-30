// SDKs expose retry hints either as headers or as Google RPC RetryInfo in
// the error body. Keep only numeric timing/status metadata outside the SDK.
export function providerError(error: unknown, now = Date.now()): { statusCode: number | null; retryable: boolean; retryAfterMs: number | null } {
  const value = error as any;
  const rawStatus = value?.status ?? value?.statusCode;
  const statusCode = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
  const hints: number[] = [];
  const headers = value?.headers ?? value?.response?.headers;
  const header = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  if (typeof header === 'string' || typeof header === 'number') {
    const seconds = Number(header);
    const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(header)) - now;
    if (Number.isFinite(duration) && duration >= 0) hints.push(duration);
  }
  let body = value?.error;
  if (!body && typeof value?.message === 'string') {
    try { body = JSON.parse(value.message); } catch { /* Not a structured provider error. */ }
  }
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const details = body?.error?.details ?? body?.details;
  for (const detail of Array.isArray(details) ? details : []) {
    if (detail?.['@type']?.endsWith('/google.rpc.RetryInfo')) {
      const duration = detail.retryDelay;
      if (typeof duration === 'string' && /^\d+(?:\.\d+)?s$/.test(duration)) hints.push(Number(duration.slice(0, -1)) * 1000);
      else if (duration && typeof duration === 'object') hints.push(Number(duration.seconds ?? 0) * 1000 + Number(duration.nanos ?? 0) / 1_000_000);
    }
  }
  const prose = /(?:retry in|retry after)\s+(\d+(?:\.\d+)?)s/i.exec(value?.message ?? '');
  if (prose) hints.push(Number(prose[1]) * 1000);
  const valid = hints.filter(hint => Number.isFinite(hint) && hint >= 0);
  return { statusCode, retryable: statusCode === null || statusCode === 408 || statusCode === 429 || statusCode >= 500, retryAfterMs: valid.length ? Math.ceil(Math.max(...valid)) : null };
}
