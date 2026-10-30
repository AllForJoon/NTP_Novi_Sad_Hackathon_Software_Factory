import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProject } from '../src/tools/commands.ts';
import { verifyOutput } from './verify-output.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(repository, 'docs/evidence/jigjoy-2026-10-31');
const manifest = JSON.parse(readFileSync(resolve(evidence, 'manifest.json'), 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const within = (base, path) => {
  assert.ok(path && !path.includes('\\') && !path.includes(':') && !path.split('/').includes('..'), 'Unsafe evidence path');
  const target = resolve(base, path);
  assert.ok(target.startsWith(resolve(base) + sep), 'Evidence path escapes its root');
  return target;
};

try {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.runs.length, 4);
  mkdirSync(resolve(repository, '.work'), { recursive: true });
  const scratch = mkdtempSync(resolve(repository, '.work/evidence-replay-'));
  const results = [];
  console.log('ARCHIVED LIVE OUTPUT REPLAY: no inference, login or API key; compiling unchanged generated sources.');
  for (const run of manifest.runs) {
    const source = within(evidence, run.projectDirectory);
    assert.equal(run.status, 'COMPLETED'); assert.equal(run.provider, 'jigjoy'); assert.equal(run.mode, 'live');
    assert.equal(hash(within(repository, run.spec)), run.specSha256, `${run.kind}: specification integrity`);
    for (const [file, expected] of Object.entries(run.files)) assert.equal(hash(within(source, file)), expected, `${run.kind}/${file}: original artifact integrity`);
    const events = readFileSync(resolve(source, '..', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    for (const role of ['pm', 'tech-lead', 'developer-a', 'developer-b', 'qa', 'reviewer']) assert.ok(events.some(e => e.role === role && e.event === 'turn.completed'), `${run.kind}: ${role}`);
    const spans = ['developer-a', 'developer-b', 'qa'].map(role => ({ start: events.find(e => e.role === role && e.event === 'turn.started').timestamp, end: events.find(e => e.role === role && e.event === 'turn.completed').timestamp }));
    assert.ok(Math.max(...spans.map(s => Date.parse(s.start))) < Math.min(...spans.map(s => Date.parse(s.end))), `${run.kind}: concurrent workers`);
    assert.ok(events.some(e => e.event === 'verification.passed')); assert.equal(events.at(-1).event, 'project.completed');
    const project = within(scratch, run.kind);
    cpSync(source, project, { recursive: true });
    symlinkSync(resolve(repository, 'node_modules'), resolve(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const verification = await verifyProject(project, repository, 30000, 1, () => {}, run.kind.endsWith('-api'));
    assert.equal(verification.passed, true, JSON.stringify(verification));
    const acceptance = await verifyOutput(run.kind, project);
    assert.equal(acceptance.independentAcceptanceChecks, run.independentAcceptanceChecks);
    const generatedTests = Number(/# tests (\d+)/.exec(verification.commands[2].stdout)?.[1]);
    assert.equal(generatedTests, run.generatedTests);
    const result = { ...acceptance, generatedTests, ciExits: verification.commands.map(c => c.exitCode), sourceRunId: run.id };
    console.log(JSON.stringify(result)); results.push(result);
  }
  writeFileSync(resolve(scratch, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`PASSED: ${results.length} archived live deliveries, ${results.reduce((n, r) => n + r.generatedTests, 0)} generated QA tests, ${results.reduce((n, r) => n + r.independentAcceptanceChecks, 0)} independent acceptance checks.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
