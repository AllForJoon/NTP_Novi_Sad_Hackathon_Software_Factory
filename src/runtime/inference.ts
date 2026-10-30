import { defineRuntime, RuntimeState, ModelMessageItem, type FunctionCallItem, type FunctionCallOutputItem, type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent } from '@mozaik-ai/core';
import { redact } from '../tools/commands.js';
import { providerError } from './provider-errors.js';
import { WorkerAnswerSchema } from '../schemas.js';

export interface ProviderRetryOptions {
  maxRetries: number;
  onRetry?: (event: { contextId: string; model: string; retry: number; delayMs: number; statusCode: number | null; message: string }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function defaultRunner(): InferenceRunner {
  // Acquire the configured v4 default through the public runtime API.
  class ProviderState extends RuntimeState {}
  return defineRuntime<ProviderState>().initializeRuntime({ state: new ProviderState() }).getInferenceRunner();
}
export class BoundedRunner implements InferenceRunner {
  private readonly calls = new Map<string, number>();
  private readonly cooldowns = new Map<string, number>();
  constructor(private readonly underlying: InferenceRunner, private readonly timeoutMs: number, private readonly maxCalls: number, private readonly active: () => boolean, private readonly retries?: ProviderRetryOptions) {}
  private async request(input: InferenceInput): Promise<InferenceOutput> {
    const now = this.retries?.now ?? Date.now;
    const sleep = this.retries?.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (let retry = 0; ; retry++) {
      while ((this.cooldowns.get(input.model) ?? 0) > now()) {
        if (!this.active()) throw new Error('Factory run ended');
        await sleep(Math.min(200, this.cooldowns.get(input.model)! - now()));
      }
      if (!this.active()) throw new Error('Factory run ended');
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          this.underlying.run(input),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Model request timed out')), this.timeoutMs); }),
        ]);
      } catch (error) {
        const info = providerError(error, now());
        if (!info.retryable || retry >= (this.retries?.maxRetries ?? 0) || !this.active()) throw error;
        // A shared model cooldown lets all three independent workers remain alive
        // without repeatedly hitting the same quota. Retry the identical context,
        // including completed tools and provider signatures, rather than the turn.
        const delayMs = info.retryAfterMs === null ? Math.min(1000 * 2 ** retry, 10000) : info.retryAfterMs + 500;
        this.cooldowns.set(input.model, Math.max(this.cooldowns.get(input.model) ?? 0, now() + delayMs));
        this.retries?.onRetry?.({ contextId: input.context.id, model: input.model, retry: retry + 1, delayMs, statusCode: info.statusCode, message: redact(error instanceof Error ? error.message : String(error)) });
      } finally { if (timer) clearTimeout(timer); }
    }
  }
  async run(input: InferenceInput): Promise<InferenceOutput> {
    // Mozaik has already invoked finish_work, checked the complete owned-file
    // set, and appended its result. Forward the model's validated summary as the
    // terminal answer without another inference request or invented CI result.
    const items = input.context.getItems();
    const last = items.at(-1);
    if (last?.type === 'function_call_output' && input.tools?.some(tool => tool.name === 'finish_work')) {
      const result = last as FunctionCallOutputItem;
      const call = items.find(item => item.type === 'function_call' && (item as FunctionCallItem).callId === result.callId) as FunctionCallItem | undefined;
      if (call?.name === 'finish_work') {
        try {
          const submitted = JSON.parse(result.output.text);
          if (submitted.__factorySubmission === true) {
            const answer = WorkerAnswerSchema.parse({ summary: submitted.summary });
            return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify(answer) })], tokenUsage: undefined, rowResponse: { __factorySubmission: true } };
          }
        } catch { /* A denied/incomplete submission stays in the tool loop. */ }
      }
    }
    const count = (this.calls.get(input.context.id) ?? 0) + 1;
    this.calls.set(input.context.id, count);
    try {
      if (!this.active()) throw new Error('Factory run ended');
      if (count > this.maxCalls) return fault('protocol', 'Model call limit exceeded');
      const output = await this.request(input);
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
    } catch (error) {
      // v4 runLoop is fire-and-forget and has no public error event. Convert provider
      // rejection into a typed terminal answer, handled separately from product bugs.
      const info = providerError(error);
      return fault('provider', redact(error instanceof Error ? error.message : String(error)), { ...info, retriesHandled: this.retries !== undefined });
    }
  }
  async *stream(_input: InferenceInput): AsyncGenerator<SemanticEvent> { throw new Error('Streaming is disabled in the factory'); }
}
function fault(category: string, message: string, metadata: { statusCode?: number | null; retryable?: boolean; retryAfterMs?: number | null; retriesHandled?: boolean } = {}): InferenceOutput {
  return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify({ __factoryFault: { category, message, ...metadata } }) })], tokenUsage: undefined, rowResponse: null };
}
