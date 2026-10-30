import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ModelMessageItem, UserMessageItem, type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent } from '@mozaik-ai/core';
import { runFactory } from '../src/factory/company.js';
import { loadConfig } from '../src/config.js';
import { contractInvariants, planInvariants } from '../src/participants/prompts.js';
import { ContractSchema, PlanSchema, parseContract, parsePlan, type EngineeringPlan, type ProductContract } from '../src/schemas.js';
import { DemoRunner, demoContract, demoPlan } from '../src/testing/demo-runner.js';

const spec = readFileSync(resolve('specs/examples/sum-cli.md'), 'utf8');
const config = { ...loadConfig({}), commandTimeoutMs: 20000, runTimeoutMs: 60000 };
type PlanningRole = 'pm' | 'tech-lead';
interface PlanningRequest {
  role: PlanningRole; task: string; specification?: string; contract?: ProductContract;
  previousInvalidContract?: ProductContract; previousInvalidPlan?: EngineeringPlan;
  validationError?: string; instruction?: string; invariants?: string[]; retryIndex?: number;
}
class ScriptedPlanningRunner implements InferenceRunner {
  readonly requests: PlanningRequest[] = [];
  private readonly fixture = new DemoRunner();
  constructor(private readonly scripts: Partial<Record<PlanningRole, (request: PlanningRequest, attempt: number) => unknown>>) {}
  async run(input: InferenceInput): Promise<InferenceOutput> {
    const message = input.context.getItems().filter(item => item instanceof UserMessageItem).at(-1)!;
    const request = JSON.parse(message.content.text) as PlanningRequest;
    const script = this.scripts[request.role];
    if (!script) return this.fixture.run(input);
    this.requests.push(request);
    const attempt = this.requests.filter(item => item.role === request.role).length;
    return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify(script(request, attempt)) })], tokenUsage: undefined, rowResponse: null };
  }
  async *stream(_input: InferenceInput): AsyncGenerator<SemanticEvent> { throw new Error('Scripted planner does not stream'); }
}
const run = (runner: InferenceRunner, maxPlanningRetries = 2) => runFactory({
  root: mkdtempSync(resolve(tmpdir(), 'factory-planning-')), toolchainRoot: process.cwd(),
  spec, runner, quiet: true, mode: 'offline-fixture', config: { ...config, maxPlanningRetries },
});
const serialPlan = (): EngineeringPlan => {
  const plan = structuredClone(demoPlan);
  plan.tickets[1]!.dependencies = [plan.tickets[0]!.id];
  return plan;
};
const concurrencyError = 'Plan needs independent initial tickets for both developers';

test('Tech Lead repairs a schema-valid serial plan using exact evidence, then all workers launch', { timeout: 60000 }, async () => {
  const invalid = serialPlan();
  assert.doesNotThrow(() => PlanSchema.parse(invalid));
  assert.throws(() => parsePlan(invalid, demoContract), { message: concurrencyError });
  const runner = new ScriptedPlanningRunner({ 'tech-lead': (_, attempt) => attempt === 1 ? invalid : demoPlan });
  const result = await run(runner);
  assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
  assert.equal(runner.requests.length, 2);
  const repair = runner.requests[1]!;
  assert.equal(repair.role, 'tech-lead'); assert.equal(repair.task, 'repair-plan');
  assert.deepEqual(repair.contract, demoContract); assert.deepEqual(repair.previousInvalidPlan, invalid);
  assert.equal(repair.validationError, concurrencyError); assert.equal(repair.retryIndex, 1);
  assert.match(repair.instruction!, /Repair only the invalid plan constraints/);
  assert.deepEqual(repair.invariants, planInvariants);
  assert.deepEqual(result.state.engineeringPlan, demoPlan);
  const events = result.trace.records;
  const failed = events.find(e => e.event === 'plan.validation_failed')!;
  const requested = events.find(e => e.event === 'plan.repair_requested')!;
  assert.equal(failed.role, 'tech-lead'); assert.equal(failed.runId, result.state.runId); assert.equal(failed.retry, 0);
  assert.equal((failed.detail as { validationError: string }).validationError, concurrencyError);
  assert.equal(requested.retry, 1); assert.equal(requested.role, 'tech-lead');
  assert.equal(new Set(events.filter(e => e.role === 'tech-lead' && e.event === 'turn.started').map(e => e.participant)).size, 1, 'Same Tech Lead participant handles repair');
  const ready = events.findIndex(e => e.event === 'plan.ready');
  assert.ok(ready > events.indexOf(requested));
  for (const role of ['developer-a', 'developer-b', 'qa'])
    assert.ok(events.findIndex(e => e.role === role && e.event === 'turn.started') > ready);
  assert.ok(!events.some(e => e.event === 'provider.failed'));
});

test('Repeated invalid plans exhaust two repairs and fail cleanly before developer work', { timeout: 10000 }, async () => {
  const runner = new ScriptedPlanningRunner({ 'tech-lead': serialPlan });
  const result = await run(runner);
  assert.equal(result.state.status, 'FAILED'); assert.equal(runner.requests.length, 3);
  assert.deepEqual(runner.requests.map(r => r.retryIndex ?? 0), [0, 1, 2]);
  assert.equal(result.state.engineeringPlan, null); assert.equal(result.state.tickets.length, 0);
  assert.equal(result.state.activeTurns.size, 0); assert.equal(result.state.testResults.length, 0);
  const failed = result.trace.records.filter(e => e.event === 'plan.validation_failed');
  assert.deepEqual(failed.map(e => e.retry), [0, 1, 2]);
  assert.deepEqual(result.trace.records.filter(e => e.event === 'plan.repair_requested').map(e => e.retry), [1, 2]);
  assert.ok(!result.trace.records.some(e => ['plan.ready', 'ticket.claimed', 'bug.created', 'provider.failed'].includes(e.event)));
  assert.equal(result.state.failures.at(-1)?.category, 'protocol');
  assert.match(result.state.failures.at(-1)!.message, /plan semantic validation exhausted after 3 attempt\(s\) \(2 repair\(s\)\)/);
  const snapshot = JSON.parse(readFileSync(resolve(result.trace.directory, 'state.json'), 'utf8'));
  assert.equal(snapshot.status, 'FAILED');
});

test('The final permitted plan repair succeeds and receives the latest rejected candidate', { timeout: 60000 }, async () => {
  const conflicting = structuredClone(demoPlan);
  conflicting.tickets[1]!.ownedFiles = ['src/index.ts'];
  const runner = new ScriptedPlanningRunner({ 'tech-lead': (_, attempt) => attempt === 1 ? serialPlan() : attempt === 2 ? conflicting : demoPlan });
  const result = await run(runner, 2);
  assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
  assert.equal(runner.requests.length, 3);
  assert.equal(runner.requests[2]!.retryIndex, 2);
  assert.deepEqual(runner.requests[2]!.previousInvalidPlan, conflicting);
  assert.equal(runner.requests[2]!.validationError, 'Invalid/conflicting ownership: src/index.ts');
  assert.deepEqual(result.trace.records.filter(e => e.event === 'plan.repair_requested').map(e => e.retry), [1, 2]);
});

const badContracts: { name: string; error: string; make: () => ProductContract }[] = [
  { name: 'duplicate IDs', error: 'Duplicate contract IDs', make: () => ({ ...structuredClone(demoContract), requirements: [...demoContract.requirements, demoContract.requirements[0]!] }) },
  { name: 'unknown references', error: 'Unknown requirement: MISSING', make: () => {
    const contract = structuredClone(demoContract); contract.acceptanceCriteria[0]!.requirementIds = ['MISSING']; return contract;
  } },
  { name: 'uncovered requirements', error: 'Requirement R5 has no acceptance coverage', make: () => ({ ...structuredClone(demoContract), requirements: [...demoContract.requirements, { id: 'R5', description: 'Uncovered requirement' }] }) },
];
for (const item of badContracts) {
  test(`PM repairs ${item.name} with original spec and exact invalid contract`, { timeout: 60000 }, async () => {
    const invalid = item.make();
    assert.doesNotThrow(() => ContractSchema.parse(invalid));
    assert.throws(() => parseContract(invalid), { message: item.error });
    const runner = new ScriptedPlanningRunner({ pm: (_, attempt) => attempt === 1 ? invalid : demoContract });
    const result = await run(runner);
    assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
    assert.equal(runner.requests.length, 2);
    const repair = runner.requests[1]!;
    assert.equal(repair.role, 'pm'); assert.equal(repair.task, 'repair-contract');
    assert.equal(repair.specification, spec); assert.deepEqual(repair.previousInvalidContract, invalid);
    assert.equal(repair.validationError, item.error); assert.deepEqual(repair.invariants, contractInvariants);
    assert.equal(repair.retryIndex, 1); assert.match(repair.instruction!, /Repair only the invalid contract constraints/);
    assert.deepEqual(result.state.productContract, demoContract);
    const events = result.trace.records;
    const requested = events.findIndex(e => e.event === 'contract.repair_requested');
    const ready = events.findIndex(e => e.event === 'contract.ready');
    assert.ok(requested >= 0 && ready > requested);
    assert.ok(events.findIndex(e => e.role === 'tech-lead' && e.event === 'turn.started') > ready);
    const failed = events.find(e => e.event === 'contract.validation_failed')!;
    assert.equal(failed.role, 'pm'); assert.equal(failed.retry, 0); assert.equal(failed.runId, result.state.runId);
    assert.equal((failed.detail as { validationError: string }).validationError, item.error);
    assert.equal(new Set(events.filter(e => e.role === 'pm' && e.event === 'turn.started').map(e => e.participant)).size, 1);
  });
}

test('PM exhaustion has a separate bounded failure before any plan is requested', { timeout: 10000 }, async () => {
  const runner = new ScriptedPlanningRunner({ pm: badContracts[0]!.make });
  const result = await run(runner, 1);
  assert.equal(result.state.status, 'FAILED'); assert.equal(runner.requests.length, 2);
  assert.equal(result.state.productContract, null); assert.equal(result.state.engineeringPlan, null);
  assert.equal(result.trace.records.filter(e => e.event === 'contract.validation_failed').length, 2);
  assert.equal(result.trace.records.filter(e => e.event === 'contract.repair_requested').length, 1);
  assert.ok(!result.trace.records.some(e => e.role === 'tech-lead' && e.event === 'turn.started'));
  assert.equal(result.state.failures.at(-1)?.category, 'protocol');
  assert.match(result.state.failures.at(-1)!.message, /contract semantic validation exhausted after 2 attempt/);
});

test('Zero planning budget performs the initial validation without invoking a repair', { timeout: 10000 }, async () => {
  const runner = new ScriptedPlanningRunner({ 'tech-lead': serialPlan });
  const result = await run(runner, 0);
  assert.equal(result.state.status, 'FAILED'); assert.equal(runner.requests.length, 1);
  assert.equal(result.trace.records.filter(e => e.event === 'plan.validation_failed').length, 1);
  assert.ok(!result.trace.records.some(e => e.event === 'plan.repair_requested'));
});

test('Basic schema errors keep their protocol failure path and do not consume semantic repairs', { timeout: 10000 }, async () => {
  const runner = new ScriptedPlanningRunner({ pm: () => ({ projectType: 'cli' }) });
  const result = await run(runner);
  assert.equal(result.state.status, 'FAILED'); assert.equal(runner.requests.length, 1);
  assert.ok(!result.trace.records.some(e => e.event === 'contract.repair_requested'));
  assert.equal(result.state.failures.at(-1)?.category, 'protocol');
});

test('Semantic validation evidence is redacted in persisted traces and terminal failures', { timeout: 10000 }, async () => {
  const keyPattern = 'sk-' + 'x'.repeat(24);
  const invalid = structuredClone(demoContract);
  invalid.acceptanceCriteria[0]!.requirementIds = [keyPattern];
  const result = await run(new ScriptedPlanningRunner({ pm: () => invalid }), 0);
  assert.equal(result.state.status, 'FAILED');
  const events = readFileSync(resolve(result.trace.directory, 'events.jsonl'), 'utf8');
  const snapshot = readFileSync(resolve(result.trace.directory, 'state.json'), 'utf8');
  assert.ok(!events.includes(keyPattern)); assert.ok(!snapshot.includes(keyPattern));
  assert.match(events, /Unknown requirement: \[REDACTED\]/);
  assert.ok(!result.state.failures.at(-1)!.message.includes(keyPattern));
});

test('PM and Tech Lead each receive their own planning repair budget', { timeout: 60000 }, async () => {
  const runner = new ScriptedPlanningRunner({
    pm: (_, attempt) => attempt === 1 ? badContracts[0]!.make() : demoContract,
    'tech-lead': (_, attempt) => attempt === 1 ? serialPlan() : demoPlan,
  });
  const result = await run(runner, 1);
  assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
  assert.equal(runner.requests.filter(r => r.role === 'pm').length, 2);
  assert.equal(runner.requests.filter(r => r.role === 'tech-lead').length, 2);
  assert.equal(result.trace.records.filter(e => e.event === 'contract.repair_requested').length, 1);
  assert.equal(result.trace.records.filter(e => e.event === 'plan.repair_requested').length, 1);
});
