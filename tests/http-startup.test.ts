import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FunctionCallItem, ModelMessageItem, type InferenceRunner } from '@mozaik-ai/core';
import { runNode } from '../src/tools/commands.js';
import { httpStartupCheck } from '../src/tools/http-startup.js';
import { runFactory } from '../src/factory/company.js';
import { loadConfig } from '../src/config.js';

test('HTTP startup gate rejects a silent exit and accepts an actual HTTP response on PORT', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'factory-http-startup-'));
  mkdirSync(resolve(root, 'dist'));
  writeFileSync(resolve(root, 'dist/index.js'), '');
  const missing = await runNode(root, ['--input-type=module', '-e', httpStartupCheck], 8000);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /exited before listening on PORT/);
  writeFileSync(resolve(root, 'dist/index.js'), "const http=require('node:http'); http.createServer((req,res)=>{res.statusCode=404;res.end();}).listen(Number(process.env.PORT),'127.0.0.1');");
  const ready = await runNode(root, ['--input-type=module', '-e', httpStartupCheck], 8000);
  assert.equal(ready.exitCode, 0, ready.stderr);
  assert.match(ready.stdout, /httpStartup.*passed/);
});

test('Missing HTTP direct startup reaches Reviewer triage, owner repair and four real CI gates', { timeout: 30000 }, async () => {
  const contract = {
    projectType: 'http-api', requirements: [{ id: 'R1', description: 'Export createServer; directly start HTTP on PORT' }],
    acceptanceCriteria: [{ id: 'AC1', requirementIds: ['R1'], description: 'Import returns unstarted server; executable listens on PORT' }],
    constraints: ['Node built-ins'], ambiguities: [], outOfScope: [],
  };
  const plan = { architecture: 'HTTP entry delegates response data to independent helper.', interfaces: 'src/value.ts exports body:string; src/index.ts exports createServer():http.Server; start directly on PORT.', tickets: [
    { id: 'DEV-A', title: 'Server', description: 'Implement the server and executable', owner: 'developer-a', dependencies: [], ownedFiles: ['src/index.ts'], acceptanceCriteria: ['AC1'] },
    { id: 'DEV-B', title: 'Response data', description: 'Implement response data', owner: 'developer-b', dependencies: [], ownedFiles: ['src/value.ts'], acceptanceCriteria: ['AC1'] },
  ] };
  const server = "import {createServer as createHttpServer} from 'node:http'; import {body} from './value.js'; export function createServer(){return createHttpServer((req,res)=>res.end(body));}\n";
  const direct = "import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path'; if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) createServer().listen(Number(process.env.PORT??3000),'127.0.0.1');\n";
  const runner: InferenceRunner = { async run(input) {
    const items = input.context.getItems() as any[];
    const task = JSON.parse(items.filter(item => item.role === 'user').at(-1).content.text);
    const answer = (value: unknown) => ({ items: [ModelMessageItem.rehydrate({ text: JSON.stringify(value) })], tokenUsage: undefined, rowResponse: null });
    if (task.role === 'pm') return answer(contract);
    if (task.role === 'tech-lead') return answer(plan);
    if (task.role === 'reviewer') return answer(task.task === 'triage' ? {
      ticketId: task.ticketId, verdict: 'changes_requested', blockingIssues: [{ likelyOwner: 'developer-a', files: ['src/index.ts'], reason: 'HTTP executable exits before listening', evidence: task.verification.commands.at(-1).stderr, recommendedAction: 'Start createServer on PORT when directly executed, using portable file URL conversion' }],
    } : { ticketId: task.ticketId, verdict: 'approved', blockingIssues: [] });
    if (items.some(item => item.type === 'function_call_output')) return answer({ summary: 'Written fixture artifact' });
    const content = task.role === 'developer-a' ? server + (task.task === 'repair' ? direct : '') : task.role === 'developer-b' ? "export const body='pong';" : "import {createServer} from '../dist/index.js'; import assert from 'node:assert/strict'; assert.equal(createServer().listening,false);";
    return { items: [FunctionCallItem.rehydrate({ callId: input.context.id, name: 'write_file', args: JSON.stringify({ path: task.ticket.ownedFiles[0], content }) })], tokenUsage: undefined, rowResponse: null };
  }, async *stream() {} };
  const result = await runFactory({ root: mkdtempSync(resolve(tmpdir(), 'factory-http-ci-')), toolchainRoot: process.cwd(), spec: 'Build an HTTP server, exporting createServer and directly listening on PORT.', runner, quiet: true, config: { ...loadConfig({}), commandTimeoutMs: 10000, runTimeoutMs: 25000 } });
  assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
  assert.equal(result.state.testResults.length, 2);
  assert.equal(result.state.testResults[0]?.commands.length, 4);
  assert.equal(result.state.testResults[0]?.passed, false);
  assert.match(result.state.testResults[0]!.commands[3]!.stderr, /exited before listening/);
  assert.equal(result.state.testResults[1]?.passed, true);
  assert.equal(result.state.testResults[1]?.commands.length, 4);
  assert.equal(result.state.tickets.find(ticket => ticket.parentTicketId)?.owner, 'developer-a');
  assert.ok(result.state.tickets.every(ticket => ticket.status === 'DONE'));
});
