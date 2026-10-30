import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { GeminiGenerateContent, ModelMessageItem, UserMessageItem, type InferenceRunner } from '@mozaik-ai/core';
import { ContractSchema, PlanSchema, ReviewSchema, WorkerAnswerSchema, jsonSchema, parseContract, parsePlan } from '../src/schemas.js';
import { inferenceJsonSchema, sanitizeInferenceSchema } from '../src/runtime/inference-schema.js';
import { workerTools } from '../src/tools/agent-tools.js';
import { DemoRunner, demoContract, demoPlan } from '../src/testing/demo-runner.js';
import { runFactory } from '../src/factory/company.js';
import { loadConfig } from '../src/config.js';

const forbidden = new Set(['$schema', 'pattern', 'minLength', 'maxLength', 'minProperties', 'maxProperties', 'uniqueItems', 'contains', 'minContains', 'maxContains']);
// Traverse schema positions, not property names or literal enum/required values.
function assertNoForbidden(schema: any): void {
  if (typeof schema === 'boolean') return;
  for (const key of Object.keys(schema)) assert.ok(!forbidden.has(key), `Forbidden schema keyword: ${key}`);
  for (const children of [schema.properties, schema.$defs]) if (children) for (const child of Object.values(children)) assertNoForbidden(child);
  for (const child of [schema.items, schema.additionalProperties]) if (child !== undefined) assertNoForbidden(child);
  for (const children of [schema.prefixItems, schema.anyOf, schema.oneOf]) if (children) for (const child of children) assertNoForbidden(child);
}

test('Worker answer schema removes the exact root and string constraints rejected by Gemini', () => {
  const raw = jsonSchema(WorkerAnswerSchema);
  assert.ok('$schema' in raw);
  assert.deepEqual(inferenceJsonSchema(WorkerAnswerSchema), {
    type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false,
  });
  assert.deepEqual(inferenceJsonSchema(WorkerAnswerSchema, 'gemini-3.5-flash-lite'), {
    type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'],
  });
  assert.deepEqual(jsonSchema(WorkerAnswerSchema), raw, 'Full original JSON Schema is unchanged');
});

test('Allowlist recursively sanitizes every schema container and preserves generation structure', () => {
  const restrictedString = { type: 'string', pattern: '^x', minLength: 1, maxLength: 8, $schema: 'draft', customKeyword: true };
  const raw = {
    $schema: 'draft', $id: 'example', $anchor: 'root', type: 'object', title: 'Example', description: 'Structured data',
    minProperties: 1, maxProperties: 9, customKeyword: 'drop', default: {}, examples: [],
    properties: {
      choice: { type: 'string', enum: ['x', 'y'], pattern: '^x' },
      list: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, contains: restrictedString, minContains: 1, maxContains: 2,
        items: { type: 'object', properties: { name: restrictedString }, required: ['name'], additionalProperties: restrictedString } },
      tuple: { type: 'array', prefixItems: [restrictedString, { type: 'number', minimum: 0, maximum: 10, exclusiveMinimum: 0 }], items: false },
      union: { anyOf: [restrictedString, { type: 'array', items: restrictedString }] },
      one: { oneOf: [restrictedString, { $ref: '#/$defs/Number' }] },
    },
    required: ['choice', 'list'], additionalProperties: false,
    $defs: { Number: { type: 'number', minimum: 0, maximum: 10, multipleOf: 2 }, String: restrictedString },
  };
  const before = structuredClone(raw);
  const result = sanitizeInferenceSchema(raw) as any;
  assertNoForbidden(result);
  assert.deepEqual(raw, before, 'Sanitization must not mutate the input');
  assert.equal(result.$id, 'example'); assert.equal(result.$anchor, 'root');
  assert.equal(result.type, 'object'); assert.equal(result.title, 'Example');
  assert.equal(result.description, 'Structured data'); assert.deepEqual(result.required, ['choice', 'list']);
  assert.equal(result.additionalProperties, false); assert.deepEqual(result.properties.choice.enum, ['x', 'y']);
  assert.equal(result.properties.list.type, 'array'); assert.equal(result.properties.list.minItems, 1); assert.equal(result.properties.list.maxItems, 3);
  assert.deepEqual(result.properties.list.items.properties.name, { type: 'string' });
  assert.deepEqual(result.properties.list.items.additionalProperties, { type: 'string' });
  assert.deepEqual(result.properties.tuple.prefixItems, [{ type: 'string' }, { type: 'number', minimum: 0, maximum: 10 }]);
  assert.equal(result.properties.tuple.items, false);
  assert.deepEqual(result.properties.union.anyOf[1].items, { type: 'string' });
  assert.deepEqual(result.properties.one.oneOf, [{ type: 'string' }, { $ref: '#/$defs/Number' }]);
  assert.deepEqual(result.$defs, { Number: { type: 'number', minimum: 0, maximum: 10 }, String: { type: 'string' } });
  assert.ok(!('customKeyword' in result)); assert.ok(!('default' in result)); assert.ok(!('examples' in result));
  result.properties.choice.enum.push('changed');
  assert.deepEqual(raw.properties.choice.enum, ['x', 'y'], 'Literal arrays are cloned as well');
});

test('Keyword-shaped property names and literal enum/required data are never sanitized as schemas', () => {
  const literal = { $schema: 'literal data', pattern: 'literal data', minLength: 42 };
  const raw = { type: 'object', properties: { pattern: { type: 'string', minLength: 1 }, $schema: { enum: [literal, 'minLength'] } }, required: ['pattern', '$schema'] };
  const result = sanitizeInferenceSchema(raw) as any;
  assert.deepEqual(result.properties.pattern, { type: 'string' });
  assert.deepEqual(result.properties.$schema.enum, [literal, 'minLength']);
  assert.deepEqual(result.required, ['pattern', '$schema']);
  assertNoForbidden(result);
});

const roleSchemas = [
  ['PM', ContractSchema], ['Tech Lead', PlanSchema], ['Developer A', WorkerAnswerSchema],
  ['Developer B', WorkerAnswerSchema], ['QA', WorkerAnswerSchema], ['Reviewer', ReviewSchema],
] as const;
for (const [role, schema] of roleSchemas) {
  test(`${role}'s actual schema is clean at every level for generic and Gemini inference`, () => {
    for (const model of [undefined, 'gemini-3.5-flash-lite']) {
      const projected = inferenceJsonSchema(schema, model) as any;
      assertNoForbidden(projected);
      assert.equal(projected.type, 'object'); assert.ok(projected.properties);
      assert.deepEqual(projected.required, jsonSchema(schema).required);
      if (model) {
        const walk = (node: any): void => {
          for (const key of ['$id', '$defs', '$ref', '$anchor', 'additionalProperties', 'prefixItems', 'oneOf']) assert.ok(!(key in node), `Legacy responseSchema cannot receive ${key}`);
          for (const child of Object.values(node.properties ?? {})) walk(child);
          if (node.items) walk(node.items);
          for (const child of node.anyOf ?? []) walk(child);
        };
        walk(projected);
      }
    }
  });
}

test('PM, plan, worker and review local Zod/semantic validation retain every original constraint', () => {
  for (const [, schema] of roleSchemas) inferenceJsonSchema(schema, 'gemini-3.5-flash-lite');
  const contract = structuredClone(demoContract);
  contract.requirements[0]!.id = '1-invalid-id';
  assert.throws(() => ContractSchema.parse(contract));
  assert.throws(() => ContractSchema.parse({ ...demoContract, requirements: [] }));
  assert.throws(() => ContractSchema.parse({ ...demoContract, extra: true }));
  assert.throws(() => parseContract({ ...demoContract, requirements: [...demoContract.requirements, demoContract.requirements[0]] }), /Duplicate/);
  const plan = structuredClone(demoPlan); plan.tickets[0]!.title = '';
  assert.throws(() => PlanSchema.parse(plan));
  const serial = structuredClone(demoPlan); serial.tickets[1]!.dependencies = ['DEV-001'];
  assert.throws(() => parsePlan(serial, demoContract), /independent/);
  assert.throws(() => WorkerAnswerSchema.parse({ summary: '' }));
  assert.throws(() => WorkerAnswerSchema.parse({ summary: 'ok', unexpected: 'field' }));
  assert.throws(() => ReviewSchema.parse({ ticketId: '1-invalid', verdict: 'approved', blockingIssues: [] }));
  assert.throws(() => ReviewSchema.parse({ ticketId: 'DEV-001', verdict: 'changes_requested', blockingIssues: [{ reason: '', evidence: '', recommendedAction: '', likelyOwner: 'developer-a', files: [] }] }));
  const boundedString = z.object({ name: z.string().min(2).max(5).regex(/^x/) }).strict();
  inferenceJsonSchema(boundedString, 'gemini-3.5-flash-lite');
  for (const name of ['x', 'xxxxxx', 'wrong']) assert.throws(() => boundedString.parse({ name }));
  assert.deepEqual(boundedString.parse({ name: 'xy' }), { name: 'xy' });
});

test('Sanitized tool parameters still enforce the original Zod length and strict-property checks', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'factory-schema-tools-'));
  const tools = workerTools({ workspace: root, ticket: { ...demoPlan.tickets[0]!, status: 'IN_PROGRESS', retryCount: 0 }, toolchain: process.cwd(), timeoutMs: 5000, active: () => true, record: () => {} });
  for (const tool of tools) assertNoForbidden(tool.parameters);
  const search = tools.find(tool => tool.name === 'search_files')!;
  assert.ok((await search.invoke({ text: '' })).error);
  assert.ok((await search.invoke({ text: 'x'.repeat(201) })).error);
  assert.ok((await search.invoke({ text: 'ok', unexpected: true })).error);
});

const spec = readFileSync(resolve('specs/examples/sum-cli.md'), 'utf8');
const config = { ...loadConfig({ FACTORY_MODEL: 'gemini-3.5-flash-lite' }), commandTimeoutMs: 20000, runTimeoutMs: 60000 };
const run = (runner: InferenceRunner) => runFactory({ root: mkdtempSync(resolve(tmpdir(), 'factory-schema-run-')), toolchainRoot: process.cwd(), spec, runner, quiet: true, config });

test('Every actual role request uses sanitized schemas through the complete Gemini-model runtime path', { timeout: 60000 }, async () => {
  const roles = new Set<string>();
  const fixture = new DemoRunner();
  const endpoint = new GeminiGenerateContent(); // Public mapper only; never creates a provider client.
  const runner: InferenceRunner = { async run(input) {
    const message = input.context.getItems().filter(item => item instanceof UserMessageItem).at(-1)!;
    roles.add(JSON.parse(message.content.text).role);
    assert.equal(input.model, 'gemini-3.5-flash-lite');
    assertNoForbidden(input.structuredOutput!.schema);
    assert.ok(!('additionalProperties' in input.structuredOutput!.schema));
    for (const tool of input.tools ?? []) assertNoForbidden(tool.parameters);
    const wire = endpoint.endpointMapper.toRequest(input);
    assert.equal(wire.config.responseMimeType, 'application/json');
    assert.deepEqual(wire.config.responseSchema, input.structuredOutput!.schema);
    assertNoForbidden(wire.config.responseSchema);
    for (const group of wire.config.tools ?? [])
      for (const declaration of group.functionDeclarations) assertNoForbidden(declaration.parametersJsonSchema);
    return fixture.run(input);
  }, async *stream() {} };
  const result = await run(runner);
  assert.equal(result.state.status, 'COMPLETED', JSON.stringify(result.state.failures));
  assert.deepEqual([...roles].sort(), ['pm', 'tech-lead', 'developer-a', 'developer-b', 'qa', 'reviewer'].sort());
});

test('Factory rejects an empty worker summary despite its relaxed inference string schema', { timeout: 10000 }, async () => {
  const fixture = new DemoRunner();
  let injected = false;
  const runner: InferenceRunner = { async run(input) {
    const message = input.context.getItems().filter(item => item instanceof UserMessageItem).at(-1)!;
    if (JSON.parse(message.content.text).role === 'developer-a') {
      injected = true;
      return { items: [ModelMessageItem.rehydrate({ text: '{"summary":""}' })], tokenUsage: undefined, rowResponse: null };
    }
    return fixture.run(input);
  }, async *stream() {} };
  const result = await run(runner);
  assert.ok(injected); assert.equal(result.state.status, 'FAILED');
  assert.equal(result.state.failures.at(-1)?.category, 'protocol');
  assert.equal(result.state.testResults.length, 0);
});
