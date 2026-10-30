import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as core from '@mozaik-ai/core';
import type { InferenceInput, InferenceRunner, Tool } from '@mozaik-ai/core';
import { BoundedRunner } from '../src/runtime/inference.js';
import { on } from '../src/runtime/situations.js';
import { runFactory } from '../src/factory/company.js';
import { loadConfig } from '../src/config.js';
import { DemoRunner } from '../src/testing/demo-runner.js';
import { TraceObserver } from '../src/tracing/observer.js';
import { EngineeringState } from '../src/state.js';

// Test fixtures only. No signature is invented or submitted to a real provider.
const signatures = ['fixture-opaque-A+/==\r\n', 'fixture-opaque-B/=+\u0000'];
process.env.MOZAIK_REDACTION = 'all';
const require = createRequire(import.meta.url);
const loadCore = async (entry: 'cjs' | 'esm'): Promise<typeof core> => entry === 'cjs'
  ? core
  : import(pathToFileURL(resolve(dirname(require.resolve('@mozaik-ai/core')), 'index.mjs')).href);
const response = (part: unknown) => ({ candidates: [{ content: { role: 'model', parts: [part] } }] });
const partsOf = (request: any): any[] => request.contents.flatMap((content: any) => content.parts);

for (const entry of ['cjs', 'esm'] as const) {
  test(`${entry}: Gemini response signature survives FunctionCallItem, serialization and context replay`, async () => {
    const lib = await loadCore(entry), mapper = new lib.GeminiGenerateContent().endpointMapper;
    const part = { functionCall: { id: 'call-1', name: 'echo', args: { value: 'first', nested: { empty: '', enabled: false } } }, thoughtSignature: signatures[0]! };
    const output = mapper.toResponse(response(part));
    const call = output.items[0] as core.FunctionCallItem;
    assert.ok(call instanceof lib.FunctionCallItem);
    assert.equal(call.thoughtSignature, signatures[0]);
    const restored = lib.FunctionCallItem.rehydrate(JSON.parse(JSON.stringify(call)));
    const context = lib.ModelContext.create().addContextItems([
      lib.UserMessageItem.create('Start'), restored,
      lib.FunctionCallOutputItem.create(restored.callId, '{"ok":true}'),
    ]);
    const history = lib.ModelContext.rehydrate({ id: context.id, items: context.getItems() });
    const wire = mapper.toRequest({ model: 'gemini-3.5-flash-lite', context: history });
    assert.deepEqual(partsOf(wire).find(p => p.functionCall), part);
    assert.ok(!('thoughtSignature' in partsOf(wire).find(p => p.functionResponse)));
    // Equal call IDs in different agent contexts must never share signatures.
    const otherPart = { ...part, thoughtSignature: signatures[1]! };
    const otherCall = mapper.toResponse(response(otherPart)).items[0]!;
    const otherContext = lib.ModelContext.create().addContextItem(otherCall);
    assert.equal(partsOf(mapper.toRequest({ model: 'gemini-3.5-flash-lite', context: otherContext })).find(p => p.functionCall).thoughtSignature, signatures[1]);
    assert.equal(partsOf(mapper.toRequest({ model: 'gemini-3.5-flash-lite', context: history })).find(p => p.functionCall).thoughtSignature, signatures[0]);
  });

  test(`${entry}: absent signatures stay absent and opaque empty strings are not rewritten`, async () => {
    const lib = await loadCore(entry), mapper = new lib.GeminiGenerateContent().endpointMapper;
    for (const signature of [undefined, '']) {
      const part = { functionCall: { id: 'call-plain', name: 'echo', args: {} }, ...(signature === undefined ? {} : { thoughtSignature: signature }) };
      const call = mapper.toResponse(response(part)).items[0]! as core.FunctionCallItem;
      assert.equal(Object.hasOwn(call, 'thoughtSignature'), signature !== undefined);
      const request = mapper.toRequest({ model: 'gemini-3.5-flash-lite', context: lib.ModelContext.create().addContextItem(call) });
      assert.deepEqual(partsOf(request).find(p => p.functionCall), part);
    }
  });

  test(`${entry}: real runLoop executes two sequential tools and replays each exact signed call`, { timeout: 10000 }, async () => {
    const lib = await loadCore(entry), mapper = new lib.GeminiGenerateContent().endpointMapper;
    const originalParts = signatures.map((thoughtSignature, i) => ({
      functionCall: { id: `call-${i + 1}`, name: 'echo', args: { value: i === 0 ? 'first' : 'second' } }, thoughtSignature,
    }));
    const context = lib.ModelContext.create();
    const executed: string[] = [], capturedCalls: core.FunctionCallItem[] = [];
    let requests = 0;
    const runner: InferenceRunner = { async run(input) {
      const index = requests++;
      const wire = mapper.toRequest(input);
      const replayed = partsOf(wire).filter(p => p.functionCall);
      assert.deepEqual(replayed, originalParts.slice(0, index));
      assert.deepEqual(partsOf(wire).filter(p => p.functionResponse).map(p => p.functionResponse.id), originalParts.slice(0, index).map(p => p.functionCall.id));
      if (index < 2) {
        const output = mapper.toResponse(response(originalParts[index]));
        capturedCalls.push(output.items[0] as core.FunctionCallItem);
        return output;
      }
      return mapper.toResponse(response({ text: '{"summary":"done"}' }));
    }, async *stream() { throw new Error('Not used'); } };
    class State extends lib.RuntimeState {}
    const api = lib.defineRuntime<State>();
    api.initializeRuntime({ state: new State(), inferenceRunnerConfig: { runner: new BoundedRunner(runner, 1000, 5, () => true) } });
    const tool: Tool = { type: 'function', name: 'echo', description: 'Echo a value', strict: true,
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      async invoke(args: { value: string }) { executed.push(args.value); return { echoed: args.value }; },
    };
    let resolveAnswer!: (answer: string) => void, rejectAnswer!: (error: unknown) => void;
    const completed = new Promise<string>((resolveResult, reject) => { resolveAnswer = resolveResult; rejectAnswer = reject; });
    const actor = lib.createAgent({ name: 'signature-regression', instruction: 'Use tools', capabilities: ['echo'], tools: [tool], handlers: [
      on(['model.answer'], event => resolveAnswer((event.payload as { answer: { content: { text: string } } }).answer.content.text), rejectAnswer),
    ] });
    api.join(actor);
    const timeout = setTimeout(() => rejectAnswer(new Error('Tool loop did not finish')), 5000);
    try {
      api.runLoop(actor.getId(), 'Run both calls', { model: 'gemini-3.5-flash-lite', context, tools: [tool] });
      assert.deepEqual(JSON.parse(await completed), { summary: 'done' });
    } finally { clearTimeout(timeout); }
    assert.equal(requests, 3); assert.deepEqual(executed, ['first', 'second']);
    for (const [i, call] of capturedCalls.entries()) {
      assert.ok(context.getItems().includes(call), 'runLoop appends the same metadata-bearing object');
      assert.equal(call.thoughtSignature, signatures[i]);
    }
    assert.deepEqual(partsOf(mapper.toRequest({ model: 'gemini-3.5-flash-lite', context })).filter(p => p.functionCall), originalParts);
  });
}

for (const [name, endpoint] of [
  ['OpenAI Responses', new core.OpenAIResponses()],
  ['OpenAI Chat Completions', new core.OpenAIChatCompletions()],
  ['Anthropic', new core.AnthropicMessages()],
] as const) {
  test(`${name} mapping ignores Gemini metadata and unsigned generic calls keep their existing shape`, () => {
    const makeContext = (signed: boolean) => core.ModelContext.create().addContextItems([
      core.UserMessageItem.create('Start'),
      core.FunctionCallItem.rehydrate({ callId: 'call-1', name: 'echo', args: '{"value":"same"}', ...(signed ? { thoughtSignature: signatures[0] } : {}) }),
      core.FunctionCallOutputItem.create('call-1', '{"ok":true}'),
    ]);
    const plain = endpoint.endpointMapper.toRequest({ model: 'fixture-model', context: makeContext(false) });
    const signed = endpoint.endpointMapper.toRequest({ model: 'fixture-model', context: makeContext(true) });
    assert.deepEqual(signed, plain);
    assert.ok(!JSON.stringify(signed).includes('fixture-opaque-'));
    assert.deepEqual(Object.keys(core.FunctionCallItem.rehydrate({ callId: 'x', name: 'echo', args: '{}' })).sort(), ['type', 'callId', 'name', 'args'].sort());
  });
}

test('Trace events and state snapshots redact opaque metadata without changing in-memory signatures', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'factory-signature-log-'));
  const state = new EngineeringState('signature-log', '# Fixture');
  const detail = { thoughtSignature: signatures[0], nested: { thought_signature: signatures[1] }, thoughtSignaturePresent: true };
  Object.assign(state, { providerDiagnostic: detail });
  const observer = new TraceObserver(root, state, true);
  observer.record({ role: 'test', event: 'metadata.preserved', detail }); observer.checkpoint();
  for (const file of ['events.jsonl', 'activity.log', 'state.json'])
    assert.ok(!readFileSync(resolve(observer.directory, file), 'utf8').includes('fixture-opaque-'));
  assert.ok(!JSON.stringify(observer.records).includes('fixture-opaque-'));
  assert.equal(detail.thoughtSignature, signatures[0]);
  assert.equal(detail.nested.thought_signature, signatures[1]);
  assert.equal((observer.records[0]!.detail as typeof detail).thoughtSignaturePresent, true);
});

test('Factory replays signed Gemini tool calls and keeps raw signatures out of all normal logs', { timeout: 60000 }, async () => {
  const fixture = new DemoRunner(), mapper = new core.GeminiGenerateContent().endpointMapper;
  const expected = new Map<string, string>();
  const replayed = new Set<string>();
  const runner: InferenceRunner = { async run(input: InferenceInput) {
    const wire = mapper.toRequest(input);
    for (const part of partsOf(wire).filter(p => p.functionCall)) {
      assert.equal(part.thoughtSignature, expected.get(part.functionCall.id));
      replayed.add(part.functionCall.id);
    }
    const output = await fixture.run(input);
    const call = output.items.find(item => item instanceof core.FunctionCallItem);
    if (!call) return output;
    const signature = `fixture-opaque-${call.callId}+/==`;
    expected.set(call.callId, signature);
    return mapper.toResponse(response({ functionCall: { id: call.callId, name: call.name, args: JSON.parse(call.args) }, thoughtSignature: signature }));
  }, async *stream() { throw new Error('Not used'); } };
  const result = await runFactory({ root: mkdtempSync(resolve(tmpdir(), 'factory-signature-e2e-')), toolchainRoot: process.cwd(),
    spec: readFileSync(resolve('specs/examples/sum-cli.md'), 'utf8'), runner, quiet: true,
    config: { ...loadConfig({ FACTORY_MODEL: 'gemini-3.5-flash-lite' }), commandTimeoutMs: 20000, runTimeoutMs: 60000 },
  });
  assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
  assert.equal(expected.size, 3); assert.equal(replayed.size, expected.size);
  for (const file of ['events.jsonl', 'activity.log', 'state.json'])
    assert.ok(!readFileSync(resolve(result.trace.directory, file), 'utf8').includes('fixture-opaque-'));
});
