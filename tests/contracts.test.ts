import test from 'node:test';
import assert from 'node:assert/strict';
import { availableModels, loadConfig, validateModels } from '../src/config.js';
import { spawnSync } from 'node:child_process';
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

test('Live configuration requires a chosen model instead of silently selecting a provider default', () => {
  for (const provider of ['auto', 'openai', 'anthropic', 'gemini', 'jigjoy']) {
    const config = loadConfig({ FACTORY_PROVIDER: provider });
    assert.ok(Object.values(config.models).every(model => model === ''));
    assert.throws(() => validateModels(config, {}), /Choose FACTORY_MODEL/);
  }
  assert.throws(() => validateModels(loadConfig({ FACTORY_MODEL: '   ', QA_MODEL: 'qa-only' }), {}), /Missing models for: pm/);
  assert.equal(loadConfig({ FACTORY_PROVIDER: ' OpenAI ', FACTORY_MODEL: ' selected-model ' }).models.pm, 'selected-model');
});

test('Every advertised API model validates its own provider key and rejects unrelated or missing keys', () => {
  const models = availableModels();
  assert.deepEqual(new Set(models.map(model => model.provider)), new Set(['openai', 'anthropic', 'gemini']));
  for (const model of models) {
    const config = loadConfig({ FACTORY_PROVIDER: model.provider, FACTORY_MODEL: model.model });
    assert.ok(Object.values(config.models).every(name => name === model.model));
    validateModels(config, { [model.apiKeyEnv]: 'local-fixture-key' });
    assert.throws(() => validateModels(config, {}), new RegExp(model.apiKeyEnv));
    assert.throws(() => validateModels(config, { [model.apiKeyEnv]: '  ' }), new RegExp(model.apiKeyEnv));
    const other = models.find(choice => choice.provider !== model.provider)!;
    assert.throws(() => validateModels(config, { [other.apiKeyEnv]: 'unrelated-fixture-key' }), new RegExp(model.apiKeyEnv));
    assert.throws(() => validateModels(loadConfig({ FACTORY_PROVIDER: other.provider, FACTORY_MODEL: model.model }), {}), /does not belong/);
  }
  assert.throws(() => validateModels(loadConfig({ FACTORY_MODEL: 'unknown-model' }), {}), /npm run models/);
  assert.throws(() => validateModels(loadConfig({ FACTORY_MODEL: 'deepseek-v4-pro' }), { OPENAI_API_KEY: 'local-fixture-key' }), /no direct API provider/);
});

test('Explicit role selections and auto mode validate every selected provider without implicit models', () => {
  const choices = availableModels();
  const openai = choices.find(model => model.provider === 'openai')!;
  const anthropic = choices.find(model => model.provider === 'anthropic')!;
  const config = loadConfig({ FACTORY_MODEL: openai.model, QA_MODEL: anthropic.model });
  const keys = { OPENAI_API_KEY: 'local-openai-fixture', ANTHROPIC_API_KEY: 'local-anthropic-fixture' };
  validateModels(config, keys);
  assert.equal(config.models.pm, openai.model); assert.equal(config.models.qa, anthropic.model);
  assert.throws(() => validateModels(config, { OPENAI_API_KEY: keys.OPENAI_API_KEY }), /ANTHROPIC_API_KEY/);
  const roleOnly = loadConfig(Object.fromEntries(['PM_MODEL', 'TECH_LEAD_MODEL', 'IMPLEMENTATION_DEV_MODEL', 'RELIABILITY_DEV_MODEL', 'QA_MODEL', 'REVIEWER_MODEL'].map(key => [key, openai.model])));
  validateModels(roleOnly, keys);
});

test('CLI model discovery works without valid runtime configuration and never displays API key values', { timeout: 15000 }, () => {
  const secret = 'fixture-key-that-must-not-be-listed';
  const env = { ...process.env, FACTORY_PROVIDER: 'intentionally-invalid', FACTORY_MODEL: '', OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' };
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--list-models'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  for (const choice of availableModels()) assert.ok(result.stdout.includes(`${choice.provider}\t${choice.model}\t${choice.apiKeyEnv}`));
  assert.ok(!result.stdout.includes(secret)); assert.ok(!result.stderr.includes(secret));
  const conflicting = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--list-models', 'specs/examples/sum-cli.md'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(conflicting.status, 1); assert.match(conflicting.stderr, /--list-models alone/);
});
