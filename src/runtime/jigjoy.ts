import { OpenAIChatCompletions, ModelMessageItem, type FunctionCallItem, type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent } from '@mozaik-ai/core';
import { acquireJigJoyCredential, JigJoyError, type GatewayCredential } from './jigjoy-auth.js';
import { redact, registerSecret } from '../tools/commands.js';

type JsonMode = 'json_schema' | 'json_object' | 'prompt';
interface JigJoyOptions {
  timeoutMs?: number;
  credential?: () => Promise<GatewayCredential>;
  fetch?: typeof fetch;
}

// Baro's hosted provider uses the OpenAI-compatible gateway with a scoped
// credential issued by its official helper. Mozaik still owns every tool loop.
export class JigJoyInferenceRunner implements InferenceRunner {
  private readonly mapper = new OpenAIChatCompletions().endpointMapper;
  private pendingCredential?: Promise<GatewayCredential>;
  private readonly jsonModes = new Map<string, JsonMode>();
  // Preserve provider reasoning on the exact tool-call objects that Mozaik
  // appends to context. Context-local identity avoids collisions across agents.
  private readonly assistantMetadata = new WeakMap<FunctionCallItem, { reasoning?: string; content?: string | null }>();
  constructor(private readonly options: JigJoyOptions = {}) {}

  private async credential(): Promise<GatewayCredential> {
    if (!this.pendingCredential) {
      this.pendingCredential = (this.options.credential ?? acquireJigJoyCredential)().catch(error => { this.pendingCredential = undefined; throw error; });
    }
    const credential = await this.pendingCredential;
    if (Date.parse(credential.expiresAt) <= Date.now() + 60000) {
      this.pendingCredential = undefined;
      throw new JigJoyError('JigJoy gateway credential expired; retry to renew through Baro login session', 503);
    }
    registerSecret(credential.apiKey);
    return credential;
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 120000);
    const credential = await this.credential();
    let mode = this.jsonModes.get(input.model) ?? 'json_schema';
    for (;;) {
      const body = this.mapper.toRequest({ ...input, streaming: false });
      if (input.maxOutputTokens) body.max_tokens = input.maxOutputTokens;
      if (input.tools?.length) body.parallel_tool_calls = false;
      const calls = input.context.getItems().filter(item => item.type === 'function_call') as FunctionCallItem[];
      let callIndex = 0;
      for (const message of body.messages) {
        for (const _call of message.tool_calls ?? []) {
          const call = calls[callIndex++];
          const metadata = call && this.assistantMetadata.get(call);
          if (metadata?.reasoning !== undefined) message.reasoning_content = metadata.reasoning;
          if (metadata?.content !== undefined) message.content = metadata.content;
        }
      }
      if (input.structuredOutput) {
        const format = input.structuredOutput;
        if (mode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: format.name ?? 'factory_answer', schema: format.schema, strict: format.strict ?? true } };
        else if (mode === 'json_object') body.response_format = { type: 'json_object' };
        body.messages.unshift({ role: 'system', content: `When returning a final answer, return only one JSON object matching this schema. You may call authorized tools before your final answer. No markdown or commentary outside JSON. Schema: ${JSON.stringify(format.schema)}` });
      }
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(`${credential.gatewayBaseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal,
        });
      } catch (error) { throw new JigJoyError(`JigJoy gateway request failed: ${redact(error instanceof Error ? error.message : String(error))}`, 503); }
      const text = await response.text();
      if (!response.ok) {
        // Negotiate only an explicitly rejected structured-output capability.
        // Authentication, quotas and arbitrary 400s retain provider semantics.
        if (input.structuredOutput && [400, 422].includes(response.status)
          && /response_format|json_schema|json_object/i.test(text)
          && /not support|unsupported|unavailable|not available|not permitted|invalid.*(?:format|schema)|unknown.*(?:format|schema)/i.test(text) && mode !== 'prompt') {
          mode = mode === 'json_schema' ? 'json_object' : 'prompt';
          this.jsonModes.set(input.model, mode);
          continue;
        }
        if (response.status === 401) this.pendingCredential = undefined;
        throw new JigJoyError(`JigJoy gateway HTTP ${response.status}: ${redact(text).slice(0, 2000)}`, response.status, new Headers({ ...(response.headers.get('retry-after') ? { 'retry-after': response.headers.get('retry-after')! } : {}) }));
      }
      let raw: any;
      try { raw = JSON.parse(text); } catch { throw new JigJoyError('JigJoy gateway returned invalid response JSON', 502); }
      if (!raw.choices?.[0]?.message) throw new JigJoyError('JigJoy gateway returned no assistant message', 502);
      if (raw.choices[0].finish_reason === 'length') throw new JigJoyError('JigJoy model reached the output token limit', 422);
      const output = this.mapper.toResponse(raw);
      const message = raw.choices[0].message;
      for (const item of output.items) if (item.type === 'function_call') this.assistantMetadata.set(item, {
        ...(typeof message.reasoning_content === 'string' ? { reasoning: message.reasoning_content } : {}),
        ...(typeof message.content === 'string' || message.content === null ? { content: message.content } : {}),
      });
      if (input.structuredOutput && !output.items.some(item => item.type === 'function_call')) {
        // Normalize only a complete fenced JSON document; local Zod and the
        // existing planning repair validate semantics without weakened schemas.
        output.items = output.items.map(item => {
          if (item instanceof ModelMessageItem) {
            const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(item.content.text);
            if (match) { try { JSON.parse(match[1]!); return ModelMessageItem.rehydrate({ text: match[1]! }); } catch { /* Let local validation reject it. */ } }
          }
          return item;
        });
      }
      return output;
    }
  }
  async *stream(_input: InferenceInput): AsyncGenerator<SemanticEvent> { throw new Error('Factory uses non-streaming JigJoy inference'); }
}
