import test from 'node:test';
import assert from 'node:assert/strict';
import { FunctionCallItem, FunctionCallOutputItem, ModelContext, ModelMessageItem, type InferenceRunner } from '@mozaik-ai/core';
import { BoundedRunner } from '../src/runtime/inference.js';
import { providerError } from '../src/runtime/provider-errors.js';

const rpcError = (seconds: string) => Object.assign(new Error(JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: seconds }] } })), { status: 429 });
const answer = () => ({ items: [ModelMessageItem.rehydrate({ text: '{"summary":"done"}' })], tokenUsage: undefined, rowResponse: null });

test('Provider hints retain Retry-After seconds, dates and Google RPC/prose delays', () => {
  assert.equal(providerError({ status: 429, headers: { 'retry-after': '12.5' } }).retryAfterMs, 12500);
  const now = Date.UTC(2026, 9, 30);
  assert.equal(providerError({ status: 503, headers: new Headers({ 'retry-after': new Date(now + 7000).toUTCString() }) }, now).retryAfterMs, 7000);
  assert.equal(providerError(rpcError('28s')).retryAfterMs, 28000);
  assert.equal(providerError({ message: 'Please retry in 28.061314559s.', status: 429 }).retryAfterMs, 28062);
  assert.equal(providerError({ status: 429, error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: { seconds: '2', nanos: 500000000 } }] } }).retryAfterMs, 2500);
  for (const status of [400, 401, 403, 404, 422]) assert.equal(providerError({ status }).retryable, false);
});

test('Quota retry waits for provider guidance and preserves exact context, signatures and tool output', async () => {
  const call = FunctionCallItem.rehydrate({ callId: 'signed-call', name: 'write_file', args: '{}', thoughtSignature: 'local-fixture-only' });
  const context = ModelContext.create().addContextItems([call, FunctionCallOutputItem.create(call.callId, '{"written":"src/index.ts"}')]);
  const input = { model: 'test', context };
  let now = 0, calls = 0;
  const scheduled: number[] = [];
  const runner: InferenceRunner = { async run(received) {
    assert.equal(received, input);
    assert.equal(received.context.getItems()[0], call);
    assert.equal(call.thoughtSignature, 'local-fixture-only');
    if (++calls === 1) throw rpcError('28s');
    assert.ok(now >= 28500);
    return answer();
  }, async *stream() {} };
  const output = await new BoundedRunner(runner, 100, 2, () => true, { maxRetries: 1, now: () => now, sleep: async ms => { now += ms; }, onRetry: e => scheduled.push(e.delayMs) }).run(input);
  assert.equal(calls, 2);
  assert.deepEqual(scheduled, [28500]);
  assert.match((output.items[0] as ModelMessageItem).content.text, /done/);
});

test('Request retries exhaust once, deterministic 400 is not retried, and cooldown waits cancel', async () => {
  for (const status of [400, 429, 503]) {
    let calls = 0, now = 0;
    const runner: InferenceRunner = { async run() { calls++; throw Object.assign(new Error('provider failure'), { status }); }, async *stream() {} };
    const result = await new BoundedRunner(runner, 100, 2, () => true, { maxRetries: 2, now: () => now, sleep: async ms => { now += ms; } }).run({ model: 'test', context: ModelContext.create() });
    const fault = JSON.parse((result.items[0] as ModelMessageItem).content.text).__factoryFault;
    assert.equal(calls, status === 400 ? 1 : 3);
    assert.equal(fault.retriesHandled, true);
    assert.equal(fault.statusCode, status);
  }
  let active = true, calls = 0;
  const runner: InferenceRunner = { async run() { calls++; throw rpcError('120s'); }, async *stream() {} };
  await new BoundedRunner(runner, 100, 2, () => active, { maxRetries: 1, sleep: async () => { active = false; } }).run({ model: 'test', context: ModelContext.create() });
  assert.equal(calls, 1);
});
