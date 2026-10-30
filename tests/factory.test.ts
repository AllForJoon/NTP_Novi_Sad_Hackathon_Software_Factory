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
import { FunctionCallItem, ModelMessageItem, type InferenceRunner } from '@mozaik-ai/core';

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
test('Structured HTTP 400 errors stop immediately while transient status codes retain provider retries', { timeout: 10000 }, async () => {
  for (const status of [400, 429, 500, 502, 503]) {
    let calls = 0;
    const runner: InferenceRunner = { async run() { calls++; throw Object.assign(new Error(status === 400 ? 'INVALID_ARGUMENT: unsupported schema field' : 'Transient provider error'), { status }); }, async *stream() {} };
    const result = await run(runner);
    assert.equal(result.state.status, 'FAILED'); assert.equal(calls, status === 400 ? 1 : 2, `HTTP ${status}`);
    assert.ok(result.state.failures.every(f => f.category === 'provider'));
    assert.equal(result.state.tickets.length, 0);
    const event = result.trace.records.find(e => e.event === 'provider.failed')!;
    assert.equal((event.detail as { statusCode: number }).statusCode, status);
    assert.equal((event.detail as { retryable: boolean }).retryable, status !== 400);
  }
});
test('Empty specs and unsafe run IDs fail before output generation', async () => {
  await assert.rejects(() => run(new DemoRunner(), { spec: ' ' }), /empty/);
  await assert.rejects(() => run(new DemoRunner(), { runId: '../escape' }), /Unsafe/);
});
test('A quota failure after a completed tool retries that request without restarting the worker', { timeout: 15000 }, async () => {
  const fixture = new DemoRunner();
  let failedContext: string | undefined, recovered = false;
  const runner: InferenceRunner = { async run(input) {
    const items = input.context.getItems();
    if (!failedContext && items.some(item => item.type === 'function_call_output')) {
      failedContext = input.context.id;
      throw Object.assign(new Error('Please retry in 0s.'), { status: 429 });
    }
    if (input.context.id === failedContext) {
      assert.ok(items.some(item => item.type === 'function_call_output'));
      recovered = true;
    }
    return fixture.run(input);
  }, async *stream() {} };
  const result = await run(runner);
  assert.equal(result.state.status, 'COMPLETED');
  assert.equal(recovered, true);
  assert.equal(result.trace.records.filter(e => e.event === 'provider.retry_scheduled').length, 1);
  assert.equal(result.trace.records.filter(e => e.event === 'turn.started').length, 8);
  assert.ok(!result.trace.records.some(e => e.event === 'bug.created'));
});
test('Explicit worker submission reaches review and real CI without another provider summary request', { timeout: 15000 }, async () => {
  const fixture = new DemoRunner();
  const runner: InferenceRunner = { async run(input) {
    const result = await fixture.run(input);
    if (input.tools?.length && result.items[0]?.type === 'message') {
      return { ...result, items: [FunctionCallItem.rehydrate({ callId: `finish-${input.context.id}`, name: 'finish_work', args: JSON.stringify({ summary: 'Owned files submitted for review' }) })] };
    }
    assert.ok(!input.context.getItems().some(item => item.type === 'function_call' && (item as FunctionCallItem).name === 'finish_work'), 'No provider inference after valid submission');
    return result;
  }, async *stream() {} };
  const result = await run(runner);
  assert.equal(result.state.status, 'COMPLETED');
  assert.equal(result.trace.records.filter(e => e.event === 'finish_work').length, 3);
  assert.equal(result.trace.records.filter(e => e.event === 'worker.submission_completed').length, 3);
  assert.equal(result.state.testResults[0]?.passed, true);
});
test('Human interventions are explicit and normal initialization does not count', () => {
  const state = new EngineeringState('test-run', spec);
  assert.equal(state.metrics.humanInterventionCount, 0);
  state.recordHumanIntervention('manual-edit', 'User changed a generated file');
  assert.equal(state.metrics.humanInterventionCount, 1);
  assert.equal(state.humanInterventions.length, 1);
});
test('Initial reviews, CI repairs and bug reviews each retain their independent bounded budgets', { timeout: 20000 }, async () => {
  const broken = new DemoRunner({ defect: true, unfixable: true });
  const good = new DemoRunner();
  const rejected = new Set<string>();
  const runner: InferenceRunner = { async run(input) {
    const items = input.context.getItems() as any[];
    const task = JSON.parse(items.filter(item => item.role === 'user').at(-1).content.text);
    if (task.role === 'reviewer' && task.task === 'review' && task.ticket.owner === 'developer-b' && !rejected.has(task.ticketId)) {
      rejected.add(task.ticketId);
      return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify({ ticketId: task.ticketId, verdict: 'changes_requested', blockingIssues: [{ likelyOwner: 'developer-b', files: ['src/validation.ts'], reason: 'Review requests a focused validation adjustment', evidence: 'Review of the submitted validation source', recommendedAction: 'Review validation and resubmit' }] }) })], tokenUsage: undefined, rowResponse: null };
    }
    return (task.role === 'developer-b' && task.ticket.parentTicketId ? good : broken).run(input);
  }, async *stream() {} };
  const result = await run(runner, { config: { ...config, maxRetries: 1 } });
  assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
  const original = result.state.tickets.find(ticket => ticket.id === 'DEV-002')!;
  const bug = result.state.tickets.find(ticket => ticket.parentTicketId)!;
  assert.equal(original.reviewRetryCount, 1);
  assert.equal(original.ciRetryCount, 1);
  assert.equal(bug.reviewRetryCount, 1);
  assert.equal(bug.retryCount, 1);
  assert.equal(result.state.testResults.length, 2);
  assert.equal(result.state.testResults[0]?.passed, false);
  assert.equal(result.state.testResults[1]?.passed, true);
});
test('Repair review receives fresh passing checks and dependencies separately from old failing CI', { timeout: 15000 }, async () => {
  const fixture = new DemoRunner({ defect: true });
  let inspected = false;
  const runner: InferenceRunner = { async run(input) {
    const items = input.context.getItems() as any[];
    const task = JSON.parse(items.filter(item => item.role === 'user').at(-1).content.text);
    if (task.role === 'developer-b' && task.ticket.parentTicketId && items.some(item => item.type === 'function_call_output') && !items.some(item => item.type === 'function_call' && item.name === 'run_check'))
      return { items: [FunctionCallItem.rehydrate({ callId: `check-${input.context.id}`, name: 'run_check', args: '{"check":"test"}' })], tokenUsage: undefined, rowResponse: null };
    if (task.role === 'reviewer' && task.task === 'review' && task.ticket.parentTicketId) {
      assert.equal(task.verification, null);
      assert.equal(task.previousVerification.passed, false);
      assert.match(task.dependencyArtifacts['src/index.ts'], /parseOperands/);
      assert.ok(task.candidateChecks.some((check: any) => check.command.includes('--test') && check.exitCode === 0));
      inspected = true;
    }
    return fixture.run(input);
  }, async *stream() {} };
  const result = await run(runner);
  assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
  assert.equal(inspected, true);
});
for (const recover of [true, false]) test(`Reviewer ownership decisions ${recover ? 'self-repair without weakening ownership' : 'exhaust the semantic repair bound'}`, { timeout: 15000 }, async () => {
  const fixture = new DemoRunner();
  let decisions = 0;
  const runner: InferenceRunner = { async run(input) {
    const items = input.context.getItems() as any[];
    const task = JSON.parse(items.filter(item => item.role === 'user').at(-1).content.text);
    if (task.role === 'reviewer' && task.ticketId === 'DEV-001') {
      decisions++;
      if (decisions > 1) {
        assert.equal(task.task, 'repair-review');
        assert.equal(task.reviewMode, 'review');
        assert.match(task.validationError, /may request repairs only from developer-a/);
        assert.equal(task.previousInvalidReview.blockingIssues[0].likelyOwner, 'qa');
      }
      if (!recover || decisions === 1) return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify({ ticketId: 'DEV-001', verdict: 'changes_requested', blockingIssues: [{ likelyOwner: 'qa', files: ['tests/contract.test.mjs'], reason: 'An unrelated QA assertion is wrong', evidence: 'A test contradicts the contract', recommendedAction: 'Have QA correct its assertion' }] }) })], tokenUsage: undefined, rowResponse: null };
    }
    return fixture.run(input);
  }, async *stream() {} };
  const result = await run(runner);
  assert.equal(result.state.status, recover ? 'COMPLETED' : 'FAILED');
  assert.equal(decisions, recover ? 2 : 3);
  assert.equal(result.trace.records.filter(event => event.event === 'review.validation_failed').length, recover ? 1 : 3);
  assert.ok(!result.state.reviews.some(review => review.ticketId === 'DEV-001' && review.blockingIssues.some(issue => issue.likelyOwner === 'qa')));
  if (!recover) {
    assert.match(result.state.failures.at(-1)!.message, /review semantic validation exhausted/);
    assert.equal(result.state.testResults.length, 0);
  }
});
