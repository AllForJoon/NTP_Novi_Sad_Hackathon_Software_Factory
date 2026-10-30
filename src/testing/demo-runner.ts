import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FunctionCallItem, ModelMessageItem, type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent } from '@mozaik-ai/core';
import type { EngineeringPlan, Owner, ProductContract } from '../schemas.js';

// Explicitly scripted OFFLINE FIXTURE, not an LLM or arbitrary-spec implementation.
// It still exercises real Mozaik events, tools, concurrent loops, compilation and tests.
export const demoContract: ProductContract = {
  projectType: 'cli',
  requirements: [
    { id: 'R1', description: 'sum <a> <b> prints the numerical sum and newline, exit 0' },
    { id: 'R2', description: 'Support negative, zero and decimal numbers' },
    { id: 'R3', description: 'Reject empty, whitespace, nonnumeric and nonfinite operands with stderr and nonzero exit' },
    { id: 'R4', description: 'Require sum command and exactly two operands' },
  ],
  acceptanceCriteria: [
    { id: 'AC1', requirementIds: ['R1', 'R2'], description: 'Positive, negative, decimal and zero examples produce exact sums' },
    { id: 'AC2', requirementIds: ['R3'], description: 'Invalid operands cause stderr and nonzero exit' },
    { id: 'AC3', requirementIds: ['R4'], description: 'Missing/unknown command and wrong arity cause nonzero exit' },
  ], constraints: ['TypeScript', 'Node built-ins only'], ambiguities: [], outOfScope: ['GUI', 'network', 'persistence'],
};
export const demoPlan: EngineeringPlan = {
  architecture: 'CLI entry delegates operand validation to a small pure reliability helper.',
  interfaces: 'src/validation.ts exports parseOperands(args: string[]): [number, number], throwing Error for invalid operands/arity. src/index.ts executes sum <a> <b>, prints sum and newline, catches errors to stderr and sets process.exitCode=1. Tests run node dist/index.js sum <a> <b>.',
  tickets: [
    { id: 'DEV-001', title: 'Sum command', description: 'Implement executable CLI with error handling using parseOperands from ./validation.js.', owner: 'developer-a', dependencies: [], ownedFiles: ['src/index.ts'], acceptanceCriteria: ['AC1', 'AC3'] },
    { id: 'DEV-002', title: 'Validate operands', description: 'Implement pure parseOperands(args:string[]):[number,number] with strict arity and finite number validation.', owner: 'developer-b', dependencies: [], ownedFiles: ['src/validation.ts'], acceptanceCriteria: ['AC2', 'AC3'] },
  ],
};
const cli = `import { parseOperands } from './validation.js';
try {
  const [command, ...operands] = process.argv.slice(2);
  if (command !== 'sum') throw new Error('Usage: sum <a> <b>');
  const [a, b] = parseOperands(operands);
  console.log(a + b);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;
const validation = (broken: boolean): string => `export function parseOperands(args: string[]): [number, number] {
  if (args.length !== 2) throw new Error('Exactly two operands are required');
  ${broken ? '// Defect fixture: Number(\"\") incorrectly accepts empty input.' : "if (args.some(arg => arg.trim() === '')) throw new Error('Operands cannot be empty');"}
  const values = args.map(Number);
  if (values.some(value => !Number.isFinite(value))) throw new Error('Operands must be finite numbers');
  return [values[0]!, values[1]!];
}
`;
const tests = `import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = args => spawnSync(process.execPath, ['dist/index.js', ...args], { encoding: 'utf8', timeout: 5000, shell: false });
for (const [a, b, expected] of [['2','3','5'], ['-2','3','1'], ['1.5','2.25','3.75'], ['0','0','0']]) {
  test('sum ' + a + ' ' + b, () => {
    const result = run(['sum', a, b]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, expected + '\\n');
    assert.equal(result.stderr, '');
  });
}
for (const args of [['sum','x','2'], ['sum','','2'], ['sum',' ','2'], ['sum','NaN','2'], ['sum','Infinity','2'], ['sum','1e309','2'], ['sum'], ['sum','1'], ['sum','1','2','3'], [], ['other','1','2']]) {
  test('reject ' + JSON.stringify(args), () => {
    const result = run(args);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.trim().length > 0);
    assert.equal(result.stdout, '');
  });
}
`;
export class DemoRunner implements InferenceRunner {
  constructor(private readonly options: { defect?: boolean; unfixable?: boolean; workerGate?: (role: Owner) => Promise<void> } = {}) {}
  async run(input: InferenceInput): Promise<InferenceOutput> {
    const messages = input.context.getItems() as any[];
    const task = JSON.parse(messages.filter(item => item.role === 'user').at(-1).content.text);
    const answer = (value: unknown): InferenceOutput => ({ items: [ModelMessageItem.rehydrate({ text: JSON.stringify(value) })], tokenUsage: undefined, rowResponse: null });
    await delay(15);
    if (task.role === 'pm') return answer(demoContract);
    if (task.role === 'tech-lead') return answer(demoPlan);
    if (task.role === 'reviewer') return answer(task.task === 'triage' ? {
      ticketId: task.ticketId, verdict: 'changes_requested', blockingIssues: [{
        reason: 'Empty operands were accepted as zero', evidence: 'Node contract tests for empty/whitespace operands returned exit code 0',
        recommendedAction: 'Reject empty and whitespace-only strings before Number conversion', likelyOwner: 'developer-b', files: ['src/validation.ts'],
      }],
    } : { ticketId: task.ticketId, verdict: 'approved', blockingIssues: [] });
    if (messages.some(item => item.type === 'function_call_output')) return answer({ summary: 'Scripted fixture artifact written through the workspace tool' });
    await this.options.workerGate?.(task.role);
    const file = task.ticket.ownedFiles[0];
    const content = task.role === 'developer-a' ? cli : task.role === 'qa' ? tests : validation(Boolean(this.options.defect && (this.options.unfixable || task.task !== 'repair')));
    return { items: [FunctionCallItem.rehydrate({ callId: randomUUID(), name: 'write_file', args: JSON.stringify({ path: file, content }) })], tokenUsage: undefined, rowResponse: null };
  }
  async *stream(_input: InferenceInput): AsyncGenerator<SemanticEvent> { throw new Error('Offline fixture does not stream'); }
}
