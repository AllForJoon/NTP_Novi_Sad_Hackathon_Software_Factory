import { defineRuntime, RuntimeState, ModelMessageItem, type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent } from '@mozaik-ai/core';
import { redact } from '../tools/commands.js';

export function defaultRunner(): InferenceRunner {
  // Acquire the configured v4 default through the public runtime API.
  class ProviderState extends RuntimeState {}
  return defineRuntime<ProviderState>().initializeRuntime({ state: new ProviderState() }).getInferenceRunner();
}
export class BoundedRunner implements InferenceRunner {
  private readonly calls = new Map<string, number>();
  constructor(private readonly underlying: InferenceRunner, private readonly timeoutMs: number, private readonly maxCalls: number, private readonly active: () => boolean) {}
  async run(input: InferenceInput): Promise<InferenceOutput> {
    const count = (this.calls.get(input.context.id) ?? 0) + 1;
    this.calls.set(input.context.id, count);
    try {
      if (!this.active()) throw new Error('Factory run ended');
      if (count > this.maxCalls) return fault('protocol', 'Model call limit exceeded');
      let timer: NodeJS.Timeout | undefined;
      try {
        const output = await Promise.race([
          this.underlying.run(input),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Model request timed out')), this.timeoutMs); }),
        ]);
        if (!output.items.some(item => item.type === 'message' || item.type === 'function_call')) return fault('protocol', 'Model returned no actionable output');
        // Mozaik 4.2.0 executes only the first function call in an output. Ask providers
        // for one call at a time; if they batch calls, process one without orphaned IDs.
        const calls = output.items.filter(item => item.type === 'function_call');
        if (calls[0]) {
          if (!input.tools?.some(tool => tool.name === calls[0]!.name)) return fault('protocol', `Unknown or unauthorized tool: ${calls[0].name}`);
          try { JSON.parse(calls[0].args); } catch { return fault('protocol', 'Malformed tool arguments'); }
        }
        for (const item of output.items) if (item.type === 'reasoning') input.context.addContextItem(item);
        return calls.length ? { ...output, items: [calls[0]!] } : output;
      } finally { if (timer) clearTimeout(timer); }
    } catch (error) {
      // v4 runLoop is fire-and-forget and has no public error event. Convert provider
      // rejection into a typed terminal answer, handled separately from product bugs.
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      const statusCode = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
      return fault('provider', redact(error instanceof Error ? error.message : String(error)), { statusCode, retryable: statusCode !== 400 });
    }
  }
  async *stream(_input: InferenceInput): AsyncGenerator<SemanticEvent> { throw new Error('Streaming is disabled in the factory'); }
}
function fault(category: string, message: string, metadata: { statusCode?: number | null; retryable?: boolean } = {}): InferenceOutput {
  return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify({ __factoryFault: { category, message, ...metadata } }) })], tokenUsage: undefined, rowResponse: null };
}
