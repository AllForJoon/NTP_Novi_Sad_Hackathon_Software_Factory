import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent, defineRuntime, RuntimeState, DeveloperMessageItem, SystemMessageItem, UserMessageItem, ModelContext, ModelMessageItem, FunctionCallOutputItem, type Tool } from '@mozaik-ai/core';
import { JigJoyInferenceRunner } from '../src/runtime/jigjoy.js';
import { acquireJigJoyCredential, type GatewayCredential } from '../src/runtime/jigjoy-auth.js';
import { BoundedRunner } from '../src/runtime/inference.js';
import { providerError } from '../src/runtime/provider-errors.js';
import { loadConfig, validateModels } from '../src/config.js';
import { redact } from '../src/tools/commands.js';
import { on } from '../src/runtime/situations.js';

const credential = (): GatewayCredential => ({ schemaVersion: 1, runId: `run-local-${'a'.repeat(24)}`, gatewayBaseUrl: 'https://gateway.example/v1', apiKey: 'gk_v1.fixture.signature', expiresAt: new Date(Date.now() + 3600000).toISOString() });
const schema = { name: 'answer', schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }, strict: true };
const response = (message: any, usage = true) => Response.json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], ...(usage ? { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 3 } } } : {}) });
const call = (name: string, reasoning: string) => ({ role: 'assistant', content: null, reasoning_content: reasoning, tool_calls: [{ id: 'reused-across-contexts', type: 'function', function: { name, arguments: '{}' } }] });

test('Real Mozaik loop crosses two sequential JigJoy tool calls with exact results, reasoning and final JSON', { timeout: 10000 }, async () => {
  const bodies: any[] = [], invoked: string[] = [];
  let issued = 0;
  const runner = new JigJoyInferenceRunner({ credential: async () => { issued++; return credential(); }, fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string); bodies.push(body);
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.max_tokens, 512); assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(new Headers(init!.headers).get('authorization'), `Bearer ${credential().apiKey}`);
    assert.equal(body.response_format.type, 'json_schema');
    assert.ok(body.messages.some((m: any) => m.content === 'system-context'));
    assert.ok(body.messages.some((m: any) => m.content === 'developer-context'));
    if (bodies.length === 1) return response({ ...call('list_files', 'reasoning one'), content: 'Inspecting the tree.' });
    const tools = body.messages.filter((m: any) => m.role === 'tool');
    assert.equal(tools[0].content, JSON.stringify({ files: ['src/index.ts'] }));
    assert.equal(body.messages.find((m: any) => m.tool_calls)?.reasoning_content, 'reasoning one');
    assert.equal(body.messages.find((m: any) => m.tool_calls)?.content, 'Inspecting the tree.');
    if (bodies.length === 2) return response({ ...call('read_file', 'reasoning two'), tool_calls: [{ id: 'second-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    assert.equal(tools[1].tool_call_id, 'second-call'); assert.equal(tools[1].content, JSON.stringify({ text: 'export {};' }));
    assert.equal(body.messages.filter((m: any) => m.tool_calls)[1].reasoning_content, 'reasoning two');
    return response({ role: 'assistant', content: '{"summary":"done"}' });
  } });
  class State extends RuntimeState {}
  const api = defineRuntime<State>(); api.initializeRuntime({ state: new State(), inferenceRunnerConfig: { runner: new BoundedRunner(runner, 5000, 5, () => true) } });
  let finish!: (text: string) => void;
  const done = new Promise<string>(resolve => { finish = resolve; });
  const tools: Tool[] = ['list_files', 'read_file'].map(name => ({ type: 'function', name, description: name, parameters: { type: 'object', properties: {} }, strict: true, invoke: async () => {
    invoked.push(name); return name === 'list_files' ? { files: ['src/index.ts'] } : { text: 'export {};' };
  } }));
  const actor = createAgent({ name: 'test', instruction: 'developer-context', capabilities: [], tools, handlers: [on(['model.answer'], event => finish((event.payload as any).answer.content.text), error => finish(JSON.stringify({ error: String(error) })))] });
  api.join(actor);
  const context = ModelContext.create().addContextItems([SystemMessageItem.create('system-context'), DeveloperMessageItem.create('developer-context')]);
  api.runLoop(actor.getId(), 'do both tools', { model: 'deepseek-flash', context, tools, maxOutputTokens: 512, reasoningEffort: 'low', structuredOutput: schema });
  assert.deepEqual(JSON.parse(await done), { summary: 'done' });
  assert.deepEqual(invoked, ['list_files', 'read_file']); assert.equal(bodies.length, 3); assert.equal(issued, 1);
});

test('Only explicit unsupported format errors trigger cached JSON fallback; fenced JSON is normalized', async () => {
  const modes: string[] = [];
  const runner = new JigJoyInferenceRunner({ credential: async () => credential(), fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string); modes.push(body.response_format?.type ?? 'prompt');
    if (body.response_format?.type === 'json_schema') return Response.json({ error: { message: 'This response_format type is unavailable now' } }, { status: 400 });
    if (body.response_format?.type === 'json_object') return Response.json({ error: { message: 'json_object is not supported' } }, { status: 422 });
    assert.match(body.messages[0].content, /"summary"/);
    return response({ content: '```json\n{"summary":"valid"}\n```' }, false);
  } });
  const input = { model: 'deepseek-flash', context: ModelContext.create(), structuredOutput: schema };
  for (let i = 0; i < 2; i++) { const result = await runner.run(input); assert.equal((result.items[0] as ModelMessageItem).content.text, '{"summary":"valid"}'); assert.equal(result.tokenUsage, undefined); }
  assert.deepEqual(modes, ['json_schema', 'json_object', 'prompt', 'prompt']);
});

test('Native structured output and actual usage survive without fabricated token counts', async () => {
  const runner = new JigJoyInferenceRunner({ credential: async () => credential(), fetch: async () => response({ content: '{"summary":"ok"}' }) });
  const result = await runner.run({ model: 'deepseek-flash', context: ModelContext.create(), structuredOutput: schema });
  assert.equal(result.tokenUsage?.inputTokens, 11); assert.equal(result.tokenUsage?.outputTokens, 7); assert.equal(result.tokenUsage?.totalTokens, 18);
});

test('Concurrent contexts share one credential exchange and isolate identical tool-call IDs and reasoning', async () => {
  let issued = 0;
  const runner = new JigJoyInferenceRunner({ credential: async () => { issued++; await new Promise(resolve => setTimeout(resolve, 10)); return credential(); }, fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string); const label = body.messages.find((m: any) => m.role === 'user').content;
    const tool = body.messages.find((m: any) => m.role === 'tool');
    if (!tool) return response(call('read_file', `reasoning ${label}`));
    assert.equal(body.messages.find((m: any) => m.tool_calls).reasoning_content, `reasoning ${label}`);
    return response({ content: '{"summary":"done"}' });
  } });
  await Promise.all(['a', 'b', 'qa'].map(async label => {
    const context = ModelContext.create().addContextItem(UserMessageItem.create(label));
    const input = { model: 'deepseek-flash', context };
    const output = await runner.run(input); const item = output.items.find(i => i.type === 'function_call')!;
    context.addContextItem(item).addContextItem(FunctionCallOutputItem.create('reused-across-contexts', label));
    await runner.run(input);
  }));
  assert.equal(issued, 1);
});

test('Authentication, quota, arbitrary invalid requests and truncation stay provider errors; credentials are redacted', async () => {
  for (const status of [400, 401, 403, 429, 503]) {
    let calls = 0;
    const runner = new JigJoyInferenceRunner({ credential: async () => credential(), fetch: async () => { calls++; return Response.json({ error: 'invalid unrelated request ' + credential().apiKey }, { status, headers: { 'retry-after': '12' } }); } });
    await assert.rejects(runner.run({ model: 'deepseek-flash', context: ModelContext.create(), structuredOutput: schema }), (e: Error) => {
      assert.equal(providerError(e).statusCode, status); assert.equal(providerError(e).retryable, status === 429 || status === 503);
      assert.equal(providerError(e).retryAfterMs, 12000); assert.ok(!e.message.includes(credential().apiKey)); return true;
    }); assert.equal(calls, 1);
  }
  assert.equal(redact(credential().apiKey), '[REDACTED]');
  const runner = new JigJoyInferenceRunner({ credential: async () => credential(), fetch: async () => Response.json({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] }) });
  await assert.rejects(runner.run({ model: 'deepseek-flash', context: ModelContext.create() }), /token limit/);
});

test('Official helper stdout is captured privately and invalid/failed helper responses never leak credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jigjoy-helper-'));
  const helper = join(root, 'helper.mjs');
  writeFileSync(helper, 'console.log(' + JSON.stringify(JSON.stringify(credential())) + ');');
  assert.equal((await acquireJigJoyCredential(helper)).gatewayBaseUrl, credential().gatewayBaseUrl);
  writeFileSync(helper, `console.error(${JSON.stringify(credential().apiKey)}); process.exit(1);`);
  await assert.rejects(acquireJigJoyCredential(helper), (e: Error) => { assert.ok(!e.message.includes(credential().apiKey)); return true; });
  for (const [message, status] of [['Gateway credential exchange failed with HTTP 429', 429], ['not signed in; run baro login', 401]] as const) {
    writeFileSync(helper, 'console.error(' + JSON.stringify(message) + '); process.exit(1);');
    await assert.rejects(acquireJigJoyCredential(helper), e => { assert.equal(providerError(e).statusCode, status); return true; });
  }
  writeFileSync(helper, 'console.log("null");');
  await assert.rejects(acquireJigJoyCredential(helper), /Invalid response/);
  writeFileSync(helper, `console.log(${JSON.stringify(JSON.stringify({ ...credential(), gatewayBaseUrl: 'http://unsafe.example/v1' }))});`);
  await assert.rejects(acquireJigJoyCredential(helper), /Invalid or expired/);
});

test('JigJoy configuration requires no external provider key; explicit provider modes enforce model ownership', () => {
  const config = loadConfig({ FACTORY_PROVIDER: 'jigjoy', FACTORY_MODEL: 'deepseek-flash' }); validateModels(config, {});
  assert.equal(config.models.pm, 'deepseek-flash');
  assert.equal(config.maxOutputTokens, 32768); assert.equal(config.modelTimeoutMs, 240000);
  assert.equal(loadConfig({ FACTORY_REASONING_EFFORT: 'low' }).reasoningEffort, 'low');
  assert.throws(() => loadConfig({ FACTORY_REASONING_EFFORT: 'invalid' }), /FACTORY_REASONING_EFFORT/);
  assert.equal(loadConfig({ FACTORY_PROVIDER: 'jigjoy', MAX_OUTPUT_TOKENS: '16000' }).maxOutputTokens, 16000);
  assert.throws(() => loadConfig({ MAX_OUTPUT_TOKENS: '0' }), /MAX_OUTPUT_TOKENS/);
  assert.throws(() => loadConfig({ FACTORY_PROVIDER: 'unknown' }), /FACTORY_PROVIDER/);
  assert.throws(() => validateModels(loadConfig({ FACTORY_PROVIDER: 'anthropic', FACTORY_MODEL: 'gpt-5.4-mini' }), {}), /does not belong/);
});
