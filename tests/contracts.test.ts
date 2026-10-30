import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { parseContract, parsePlan, type EngineeringTicket } from '../src/schemas.js';
import { demoContract, demoPlan } from '../src/testing/demo-runner.js';
import { moveTicket, retryTicket } from '../src/state.js';
import { summarizeVerification } from '../src/tools/commands.js';
import type { CommandResult } from '../src/state.js';

test('Product Contract enforces required fields, unique IDs and acceptance references', () => {
  assert.deepEqual(parseContract(demoContract), demoContract);
  assert.throws(() => parseContract({ ...demoContract, projectType: 'web-app' }));
  assert.throws(() => parseContract({ ...demoContract, requirements: [...demoContract.requirements, demoContract.requirements[0]] }), /Duplicate/);
  const broken = structuredClone(demoContract);
  broken.acceptanceCriteria[0]!.requirementIds = ['NONEXISTENT'];
  assert.throws(() => parseContract(broken), /Unknown requirement/);
  assert.throws(() => parseContract({ ...demoContract, requirements: [...demoContract.requirements, { id: 'R5', description: 'uncovered' }] }), /coverage/);
});
test('Engineering plan validates DAG, coverage, disjoint ownership and independent developers', () => {
  assert.deepEqual(parsePlan(demoPlan, demoContract), demoPlan);
  const cycle = structuredClone(demoPlan);
  cycle.tickets[0]!.dependencies = ['DEV-002']; cycle.tickets[1]!.dependencies = ['DEV-001'];
  assert.throws(() => parsePlan(cycle, demoContract), /cycle/);
  const conflict = structuredClone(demoPlan);
  conflict.tickets[1]!.ownedFiles = ['src/index.ts'];
  assert.throws(() => parsePlan(conflict, demoContract), /conflicting/);
  const path = structuredClone(demoPlan); path.tickets[0]!.ownedFiles = ['../outside.ts'];
  assert.throws(() => parsePlan(path, demoContract), /ownership/);
  const missing = structuredClone(demoPlan); missing.tickets[0]!.dependencies = ['NO-SUCH'];
  assert.throws(() => parsePlan(missing, demoContract), /Unknown dependency/);
  const serial = structuredClone(demoPlan); serial.tickets[1]!.dependencies = ['DEV-001'];
  assert.throws(() => parsePlan(serial, demoContract), /independent/);
});
test('Ticket transitions enforce lifecycle and bound review retries', () => {
  const ticket: EngineeringTicket = { ...structuredClone(demoPlan.tickets[0]!), status: 'BACKLOG', retryCount: 0 };
  assert.throws(() => moveTicket(ticket, 'DONE'), /Invalid/);
  moveTicket(ticket, 'READY'); moveTicket(ticket, 'IN_PROGRESS'); moveTicket(ticket, 'IN_REVIEW'); moveTicket(ticket, 'FAILED');
  assert.equal(retryTicket(ticket, 1), true); assert.equal(ticket.retryCount, 1);
  moveTicket(ticket, 'IN_PROGRESS'); moveTicket(ticket, 'IN_REVIEW'); moveTicket(ticket, 'FAILED');
  assert.equal(retryTicket(ticket, 1), false);
});
test('Verification trusts process evidence, not words like passed in stdout', () => {
  const ok: CommandResult = { command: 'node ...', cwd: '.', exitCode: 0, signal: null, stdout: 'passed', stderr: '', elapsedMs: 1, timedOut: false, error: null };
  assert.equal(summarizeVerification([ok, ok, ok], 1).passed, true);
  assert.equal(summarizeVerification([ok], 1).passed, false);
  assert.equal(summarizeVerification([{ ...ok, exitCode: 1 }], 1).category, 'implementation');
  assert.equal(summarizeVerification([{ ...ok, timedOut: true }], 1).category, 'infrastructure');
  assert.equal(summarizeVerification([{ ...ok, exitCode: null, error: 'ENOENT' }], 1).passed, false);
});
test('Role configuration shares defaults but supports per-role models and bounded limits', () => {
  const config = loadConfig({ FACTORY_MODEL: 'shared', QA_MODEL: 'qa-only', MAX_RETRIES_PER_TICKET: '0' });
  assert.equal(config.models.pm, 'shared'); assert.equal(config.models.qa, 'qa-only'); assert.equal(config.maxRetries, 0);
  assert.equal(config.inputPrice, null);
  assert.equal(config.maxPlanningRetries, 2);
  assert.equal(loadConfig({ MAX_PLANNING_RETRIES: '0' }).maxPlanningRetries, 0);
  assert.equal(loadConfig({ MAX_PLANNING_RETRIES: '3' }).maxPlanningRetries, 3);
  for (const value of ['-1', '1.5', '6', 'NaN']) assert.throws(() => loadConfig({ MAX_PLANNING_RETRIES: value }), /MAX_PLANNING_RETRIES/);
  assert.throws(() => loadConfig({ MAX_RETRIES_PER_TICKET: '-1' }));
  assert.throws(() => loadConfig({ INPUT_USD_PER_MILLION: 'NaN' }));
});
