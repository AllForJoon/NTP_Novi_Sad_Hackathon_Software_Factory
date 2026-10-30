import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { safePath, writeOwned, captureArtifacts, integrateArtifacts } from '../src/tools/workspace.js';
import { runNode } from '../src/tools/commands.js';
import { BoundedRunner } from '../src/runtime/inference.js';
import { FunctionCallItem, ModelContext, ModelMessageItem, type InferenceInput, type InferenceRunner } from '@mozaik-ai/core';
import { demoPlan } from '../src/testing/demo-runner.js';

test('Filesystem rejects traversal, absolute paths, protected directories and symlinks', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'factory-boundary-'));
  for (const file of ['../escape', '/etc/passwd', 'C:/escape', 'src\\escape.ts', '.git/config', 'node_modules/a', 'src/CON.ts', 'src/a.ts:stream', 'src/../x.ts']) assert.throws(() => safePath(root, file), Error, file);
  const outside = mkdtempSync(resolve(tmpdir(), 'factory-outside-'));
  symlinkSync(outside, resolve(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safePath(root, 'linked/escape.ts'), /Symlink/);
  const ticket = { ...demoPlan.tickets[0]!, status: 'IN_PROGRESS' as const, retryCount: 0 };
  writeOwned(root, 'src/index.ts', 'export {};', ticket);
  assert.equal(readFileSync(resolve(root, 'src/index.ts'), 'utf8'), 'export {};');
  assert.throws(() => writeOwned(root, 'src/validation.ts', 'bad', ticket), /does not own/);
  const qa = { ...ticket, owner: 'qa' as const, ownedFiles: ['tests/contract.test.mjs'] };
  assert.throws(() => writeOwned(root, 'src/index.ts', 'bad', qa), /does not own/);
});
test('Integration rejects artifact tampering after submission', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'factory-artifact-'));
  const target = mkdtempSync(resolve(tmpdir(), 'factory-target-'));
  const ticket = { ...demoPlan.tickets[0]!, status: 'IN_PROGRESS' as const, retryCount: 0 };
  writeOwned(root, 'src/index.ts', 'export const value = 1;', ticket);
  const artifacts = captureArtifacts(root, ticket);
  integrateArtifacts(target, artifacts);
  assert.equal(readFileSync(resolve(target, 'src/index.ts'), 'utf8'), 'export const value = 1;');
  writeFileSync(resolve(root, 'src/index.ts'), 'modified');
  assert.throws(() => integrateArtifacts(target, artifacts), /changed/);
});
test('Commands use explicit cwd, strip provider secrets and record actual exit codes', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'factory-command-'));
  const result = await runNode(root, ['-e', "console.log(process.cwd()); console.log(process.env.OPENAI_API_KEY ?? 'no-key'); process.exitCode=7"], 5000);
  assert.equal(result.exitCode, 7); assert.ok(result.stdout.includes(root)); assert.ok(result.stdout.includes('no-key'));
  assert.equal(result.timedOut, false);
});
test('Command timeout terminates a hung child and reports infrastructure evidence', async () => {
  const result = await runNode(process.cwd(), ['-e', 'setInterval(()=>{},1000)'], 200);
  assert.equal(result.timedOut, true); assert.notEqual(result.exitCode, 0);
});
test('Provider failures and model call limits are typed terminal outputs', async () => {
  const failing: InferenceRunner = { async run() { throw new Error('provider unavailable'); }, async *stream() {} };
  const input: InferenceInput = { model: 'test', context: ModelContext.create() };
  const bounded = new BoundedRunner(failing, 100, 1, () => true);
  const first = await bounded.run(input);
  assert.match((first.items[0] as ModelMessageItem).content.text, /provider unavailable/);
  const second = await bounded.run(input);
  assert.match((second.items[0] as ModelMessageItem).content.text, /Model call limit/);
});
test('Unknown tools cannot escape the Mozaik function-call loop as unhandled rejections', async () => {
  const runner: InferenceRunner = { async run() { return { items: [FunctionCallItem.rehydrate({ callId: 'bad-call', name: 'arbitrary_shell', args: '{}' })], tokenUsage: undefined, rowResponse: null }; }, async *stream() {} };
  const output = await new BoundedRunner(runner, 100, 2, () => true).run({ model: 'test', context: ModelContext.create(), tools: [] });
  assert.match((output.items[0] as ModelMessageItem).content.text, /unauthorized tool/);
});
test('A hung provider request becomes a bounded provider fault', async () => {
  const runner: InferenceRunner = { async run() { return new Promise(() => {}); }, async *stream() {} };
  const output = await new BoundedRunner(runner, 50, 2, () => true).run({ model: 'test', context: ModelContext.create() });
  assert.match((output.items[0] as ModelMessageItem).content.text, /timed out/);
});
