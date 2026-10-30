import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runFactory } from '../src/factory/company.js';
import { DemoRunner } from '../src/testing/demo-runner.js';
import { loadConfig } from '../src/config.js';
import { EngineeringState } from '../src/state.js';
import type { InferenceRunner } from '@mozaik-ai/core';

const spec = readFileSync(resolve('specs/examples/sum-cli.md'), 'utf8');
const config = { ...loadConfig({}), commandTimeoutMs: 20000, runTimeoutMs: 60000 };
const run = (runner: InferenceRunner, overrides = {}) => runFactory({ root: mkdtempSync(resolve(tmpdir(), 'factory-e2e-')), toolchainRoot: process.cwd(), spec, runner, quiet: true, mode: 'offline-fixture', config, ...overrides });

test('Independent Dev A, Dev B and QA loops must all enter a barrier before any can finish', { timeout: 60000 }, async () => {
  const entered = new Set<string>();
  let release!: () => void;
  const barrier = new Promise<void>(resolveGate => { release = resolveGate; });
  const runner = new DemoRunner({ workerGate: async role => {
    entered.add(role);
    if (entered.size === 3) release();
    await Promise.race([barrier, delay(4000).then(() => { throw new Error('Workers ran sequentially; concurrency barrier timed out'); })]);
  } });
  const result = await run(runner);
  assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
  assert.equal(entered.size, 3);
  const spans = ['developer-a', 'developer-b', 'qa'].map(role => ({
    start: Date.parse(result.trace.records.find(e => e.role === role && e.event === 'turn.started')!.timestamp),
    end: Date.parse(result.trace.records.find(e => e.role === role && e.event === 'turn.completed')!.timestamp),
  }));
  assert.ok(Math.max(...spans.map(s => s.start)) < Math.min(...spans.map(s => s.end)), 'All three actual work intervals overlap');
  assert.ok(result.state.tickets.every(t => t.status === 'DONE'));
  assert.equal(result.state.testResults[0]?.commands.length, 3);
  assert.equal(result.state.metrics.inputTokens, null);
  assert.equal(result.state.metrics.estimatedCostUsd, null);
  assert.equal(result.state.metrics.humanInterventionCount, 0);
  const trace = readFileSync(resolve(result.trace.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(trace.some(e => e.event === 'project.completed'));
  assert.ok(!trace.some(e => e.detail?.answer), 'No raw provider payloads are logged');
  assert.match(readFileSync(resolve(result.outputDirectory, 'src/index.ts'), 'utf8'), /parseOperands/);
});
test('A real failed Node test creates a bug, wakes reliability engineer and passes after repair', { timeout: 60000 }, async () => {
  const result = await run(new DemoRunner({ defect: true }));
  assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
  assert.equal(result.state.testResults.length, 2);
  assert.equal(result.state.testResults[0]?.passed, false);
  assert.equal(result.state.testResults[0]?.category, 'implementation');
  assert.notEqual(result.state.testResults[0]?.commands.at(-1)?.exitCode, 0);
  assert.equal(result.state.testResults[1]?.passed, true);
  const bug = result.state.tickets.find(t => t.parentTicketId);
  assert.equal(bug?.owner, 'developer-b'); assert.equal(bug?.status, 'DONE');
  const events = result.trace.records.map(e => e.event);
  for (const event of ['verification.failed', 'bug.created', 'rework.requested', 'verification.passed']) assert.ok(events.includes(event), event);
  assert.match(readFileSync(resolve(result.outputDirectory, 'src/validation.ts'), 'utf8'), /trim/);
});
test('Unfixable product failure terminates at the configured retry bound', { timeout: 60000 }, async () => {
  const result = await run(new DemoRunner({ defect: true, unfixable: true }), { config: { ...config, maxRetries: 1 } });
  assert.equal(result.state.status, 'FAILED');
  assert.equal(result.state.testResults.length, 2);
  assert.equal(result.state.tickets.filter(t => t.parentTicketId).length, 1);
  assert.match(result.state.failures.at(-1)!.message, /Retry limit/);
});
test('Provider outages are bounded separately and never create semantic bug tickets', { timeout: 10000 }, async () => {
  let calls = 0;
  const runner: InferenceRunner = { async run() { calls++; throw new Error('network outage'); }, async *stream() {} };
  const result = await run(runner);
  assert.equal(result.state.status, 'FAILED'); assert.equal(calls, 2);
  assert.equal(result.state.tickets.length, 0);
  assert.ok(result.state.failures.every(f => f.category === 'provider'));
  assert.ok(!result.trace.records.some(e => e.event === 'bug.created'));
});
test('Empty specs and unsafe run IDs fail before output generation', async () => {
  await assert.rejects(() => run(new DemoRunner(), { spec: ' ' }), /empty/);
  await assert.rejects(() => run(new DemoRunner(), { runId: '../escape' }), /Unsafe/);
});
test('Human interventions are explicit and normal initialization does not count', () => {
  const state = new EngineeringState('test-run', spec);
  assert.equal(state.metrics.humanInterventionCount, 0);
  state.recordHumanIntervention('manual-edit', 'User changed a generated file');
  assert.equal(state.metrics.humanInterventionCount, 1);
  assert.equal(state.humanInterventions.length, 1);
});
