import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import type { CommandResult, VerificationResult } from '../state.js';
import { httpStartupCheck } from './http-startup.js';

const runtimeSecrets = new Set<string>();
export function registerSecret(secret: string): void { if (secret.length >= 6) runtimeSecrets.add(secret); }
export function redact(text: string): string {
  let result = text;
  for (const secret of runtimeSecrets) result = result.split(secret).join('[REDACTED]');
  for (const [key, value] of Object.entries(process.env))
    if (value && value.length >= 6 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) result = result.split(value).join('[REDACTED]');
  return result.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gk_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|cli_[A-Za-z0-9._~-]{8,})/g, '[REDACTED]');
}
export function runNode(cwd: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  const started = Date.now();
  return new Promise(resolveResult => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
    env.NODE_NO_WARNINGS = '1';
    const child = spawn(process.execPath, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', timedOut = false, error: string | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }, timeoutMs);
    child.stdout?.on('data', data => { stdout = (stdout + String(data)).slice(-65536); });
    child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-65536); });
    child.on('error', err => { error = redact(err.message); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({ command: `node ${args.join(' ')}`, cwd, exitCode, signal, stdout: redact(stdout), stderr: redact(stderr), elapsedMs: Date.now() - started, timedOut, error });
    });
  });
}
export function summarizeVerification(commands: CommandResult[], attempt: number, expectedCommands = 3): VerificationResult {
  const passed = commands.length === expectedCommands && commands.every(c => c.exitCode === 0 && !c.signal && !c.timedOut && !c.error);
  return { attempt, passed, category: passed ? 'passed' : commands.some(c => c.error || c.signal || c.timedOut || c.exitCode === null) ? 'infrastructure' : 'implementation', commands, timestamp: new Date().toISOString() };
}
export async function verifyProject(root: string, toolchain: string, timeoutMs: number, attempt: number, record: (result: CommandResult) => void, httpEntrypoint = false): Promise<VerificationResult> {
  const commands: CommandResult[] = [];
  const tsc = resolve(toolchain, 'node_modules/typescript/bin/tsc');
  const tests = existsSync(resolve(root, 'tests')) ? readdirSync(resolve(root, 'tests')).filter(f => f.endsWith('.test.mjs')).sort() : [];
  if (!tests.length) throw new Error('Verification requires QA test artifacts');
  const checks = [[tsc, '-p', 'tsconfig.json', '--noEmit'], [tsc, '-p', 'tsconfig.json'], ['--test', ...tests.map(f => `tests/${f}`)]];
  if (httpEntrypoint) checks.push(['--input-type=module', '-e', httpStartupCheck]);
  for (const args of checks) {
    const result = await runNode(root, args, timeoutMs);
    commands.push(result); record(result);
    if (result.exitCode !== 0 || result.signal || result.error || result.timedOut) break;
  }
  return summarizeVerification(commands, attempt, httpEntrypoint ? 4 : 3);
}
