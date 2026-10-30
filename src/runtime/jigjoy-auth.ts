import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { registerSecret } from '../tools/commands.js';

export interface GatewayCredential {
  schemaVersion: 1; runId: string; gatewayBaseUrl: string; apiKey: string; expiresAt: string;
}
export class JigJoyError extends Error {
  constructor(message: string, readonly status: number, readonly headers = new Headers()) { super(message); }
}

// This is Baro's shipped auth helper, also invoked by its native CLI. It reads
// the login session itself and validates the signed, narrowly scoped exchange.
// Never read/copy the long-lived CLI token or forward helper stdout to logs.
export async function acquireJigJoyCredential(helper = join(homedir(), '.baro', 'bin', 'acquire-gateway-credential.mjs')): Promise<GatewayCredential> {
  if (!existsSync(helper)) throw new JigJoyError('Official Baro credential helper is not installed. Install baro-ai, then run baro login.', 401);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [helper], { windowsHide: true, timeout: 15000, maxBuffer: 32768 }, (error, output, stderr) => {
      // Match only known official diagnostics; never surface arbitrary stderr.
      if (error) {
        const status = /not signed in|stored Baro login|login is no longer valid/.test(stderr) ? 401
          : /does not support login-backed Gateway/.test(stderr) ? 404
          : Number(/exchange failed with HTTP ([1-5]\d{2})/.exec(stderr)?.[1] ?? 502);
        const message = status === 401 ? 'JigJoy login is missing or invalid; run baro login.'
          : status === 404 ? 'This Baro control plane does not support login-backed hosted inference.'
          : `JigJoy credential exchange failed (HTTP ${status}); no session credentials were exposed.`;
        reject(new JigJoyError(message, status));
      }
      else resolve(output);
    });
  });
  let value: GatewayCredential;
  try { value = JSON.parse(stdout); } catch { throw new JigJoyError('Invalid response from the official Baro credential helper', 502); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JigJoyError('Invalid response from the official Baro credential helper', 502);
  if (typeof value.apiKey === 'string') registerSecret(value.apiKey);
  let url: URL;
  try { url = new URL(value.gatewayBaseUrl); } catch { throw new JigJoyError('Invalid JigJoy gateway URL', 502); }
  if (value.schemaVersion !== 1 || typeof value.runId !== 'string' || !/^run-local-[A-Za-z0-9_-]{20,128}$/.test(value.runId)
    || typeof value.apiKey !== 'string' || !/^gk_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.apiKey)
    || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/v1' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now())
    throw new JigJoyError('Invalid or expired JigJoy gateway credential', 502);
  return value;
}
