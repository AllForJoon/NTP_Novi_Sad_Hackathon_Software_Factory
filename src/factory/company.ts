import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  createAgent, createHuman, defineRuntime, DeveloperMessageItem, ModelContext,
  SemanticEvent, type Agent, type InferenceRunner, type Tool,
} from '@mozaik-ai/core';
import { loadConfig, validateModels, type FactoryConfig } from '../config.js';
import {
  ContractSchema, PlanSchema, ReviewSchema, WorkerAnswerSchema, parseContract, parsePlan,
  type EngineeringTicket, type Role, type Owner, type ReviewVerdict,
} from '../schemas.js';
import { EngineeringState, moveTicket, retryTicket, type ArtifactRecord, type CommandResult, type FailureRecord, type VerificationResult } from '../state.js';
import { on, OnEvent } from '../runtime/situations.js';
import { BoundedRunner, defaultRunner } from '../runtime/inference.js';
import { JigJoyInferenceRunner } from '../runtime/jigjoy.js';
import { inferenceJsonSchema } from '../runtime/inference-schema.js';
import { contractInvariants, instructions, planInvariants } from '../participants/prompts.js';
import { TraceObserver } from '../tracing/observer.js';
import { workerTools } from '../tools/agent-tools.js';
import { captureArtifacts, hashFile, integrateArtifacts, latestAccepted, safePath, scaffold } from '../tools/workspace.js';
import { redact, verifyProject } from '../tools/commands.js';

export interface FactoryOptions {
  root: string; spec: string; config?: FactoryConfig; runner?: InferenceRunner;
  runId?: string; quiet?: boolean; mode?: 'live' | 'offline-fixture'; toolchainRoot?: string;
}
export interface FactoryResult { state: EngineeringState; trace: TraceObserver; outputDirectory: string }
interface PendingTurn {
  contextId: string; loopId?: string; resolve: (value: unknown) => void; reject: (error: Error) => void;
  schema: z.ZodType; task: Record<string, unknown>; tools: Tool[]; ticket?: EngineeringTicket;
  retry: number; startedAt: number;
}
interface ReviewJob { mode: 'review' | 'triage'; ticketId: string; ticket?: EngineeringTicket; verification?: VerificationResult }

export async function runFactory(options: FactoryOptions): Promise<FactoryResult> {
  // Mozaik auto-exports loop context if cloud credentials exist. Keep remote
  // payloads redacted; the local observer below retains command evidence.
  process.env.MOZAIK_REDACTION = 'all';
  const config = options.config ?? loadConfig();
  if (!options.spec.trim()) throw new Error('The Markdown specification is empty');
  if (Buffer.byteLength(options.spec) > 100_000) throw new Error('Specification exceeds 100 KB');
  if (!options.runner) validateModels(config);
  const runId = options.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error('Unsafe run ID');
  const root = resolve(options.root), toolchain = resolve(options.toolchainRoot ?? root);
  const executionEnvironment = { platform: process.platform, nodeVersion: process.version, moduleSystem: 'NodeNext ESM', entrypoint: 'src/index.ts', httpStartup: 'HTTP applications must export an unstarted createServer() and start on PORT when executed directly. Direct-execution guards must convert filesystem paths with node:url pathToFileURL; concatenated file URLs are not portable.' };
  const work = safePath(root, `.work/${runId}`), output = safePath(root, `output/${runId}`);
  if (existsSync(work) || existsSync(output) || existsSync(safePath(root, `traces/${runId}`))) throw new Error('Run ID already exists; refusing to overwrite output');
  mkdirSync(work, { recursive: true });
  const state = new EngineeringState(runId, options.spec);
  const trace = new TraceObserver(root, state, options.quiet);
  const api = defineRuntime<EngineeringState>();
  api.initializeRuntime({ state, inferenceRunnerConfig: { runner: new BoundedRunner(options.runner ?? (config.provider === 'jigjoy' ? new JigJoyInferenceRunner({ timeoutMs: config.modelTimeoutMs - Math.min(1000, config.modelTimeoutMs / 10) }) : defaultRunner()), config.modelTimeoutMs, config.maxModelCalls, () => !state.terminal, {
    maxRetries: config.maxProviderRetries,
    onRetry: event => {
      const entry = [...pending.entries()].find(([, turn]) => turn.contextId === event.contextId);
      trace.record({ role: entry?.[0] ?? 'runtime', participant: entry ? actors.get(entry[0])!.getId() : 'runtime', ticketId: entry?.[1].ticket?.id ?? null, model: event.model, event: 'provider.retry_scheduled', retry: event.retry, detail: { delayMs: event.delayMs, statusCode: event.statusCode, message: event.message } });
    },
  }) } });
  const actors = new Map<Role, Agent>();
  const rolesById = new Map<string, string>();
  const pending = new Map<Role, PendingTurn>();
  const reviews: ReviewJob[] = [];
  const candidateChecks = new Map<string, CommandResult[]>();
  let reviewing = false, bugCounter = 0, timer: NodeJS.Timeout;
  let settle!: (result: FactoryResult) => void;
  const completed = new Promise<FactoryResult>(resolveResult => { settle = resolveResult; });
  const result = { state, trace, outputDirectory: output };

  const finish = (status: 'COMPLETED' | 'FAILED'): void => {
    if (state.terminal) return;
    state.status = status;
    clearTimeout(timer);
    for (const turn of pending.values()) turn.reject(new Error('Factory run ended'));
    pending.clear(); state.activeTurns.clear();
    trace.record({ role: 'company', event: status === 'COMPLETED' ? 'project.completed' : 'project.failed', phase: 'end', detail: { mode: options.mode ?? 'live', outputDirectory: output } });
    trace.checkpoint(); settle(result);
  };
  const fail = (error: unknown, category: FailureRecord['category'] = 'infrastructure', ticketId?: string): void => {
    if (state.terminal) return;
    const message = redact(error instanceof Error ? error.message : String(error));
    state.failures.push({ timestamp: new Date().toISOString(), category, message, ...(ticketId ? { ticketId } : {}) });
    trace.record({ role: 'company', event: 'failure.recorded', ticketId: ticketId ?? null, detail: { category, message } });
    finish('FAILED');
  };
  const emit = (type: string, producer: string, payload: Record<string, unknown> = {}): void => {
    if (state.terminal) return;
    api.sendEvent(SemanticEvent.create(type, producer, payload), producer);
  };
  const modelFor = (role: Role): string => options.mode === 'offline-fixture' ? 'offline-fixture' : config.models[role];
  const launch = (role: Role, turn: PendingTurn): void => {
    const actor = actors.get(role)!;
    const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(instructions[role] + '\nMake at most ONE tool call per inference response.'));
    turn.contextId = context.id;
    turn.loopId = undefined;
    trace.record({ role, participant: actor.getId(), event: 'turn.started', phase: 'start', ticketId: turn.ticket?.id ?? null, retry: turn.retry, model: modelFor(role) });
    state.activeTurns.set(role, { startedAt: turn.startedAt, retry: turn.retry, ...(turn.ticket ? { ticketId: turn.ticket.id } : {}) });
    api.runLoop(actor.getId(), JSON.stringify({ role, ...turn.task }), {
      model: modelFor(role), context, tools: turn.tools, maxOutputTokens: config.maxOutputTokens,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      structuredOutput: { name: role.replaceAll('-', '_'), schema: inferenceJsonSchema(turn.schema, modelFor(role)), strict: true },
    });
  };
  const ask = (role: Role, task: Record<string, unknown>, schema: z.ZodType, ticket?: EngineeringTicket, tools: Tool[] = []): Promise<unknown> => {
    if (pending.has(role)) throw new Error(`Concurrent turns for the same role: ${role}`);
    return new Promise((resolveTurn, reject) => {
      const turn: PendingTurn = { contextId: '', resolve: resolveTurn, reject, schema, task, tools, ticket, retry: 0, startedAt: Date.now() };
      pending.set(role, turn); launch(role, turn);
    });
  };

  const askValidated = async <T>(
    role: 'pm' | 'tech-lead' | 'reviewer', kind: 'contract' | 'plan' | 'review', initialTask: Record<string, unknown>,
    schema: z.ZodType, validate: (value: unknown) => T, invariants: readonly string[],
  ): Promise<T> => {
    let task: Record<string, unknown> = { ...initialTask, invariants };
    for (let retry = 0; ; retry++) {
      // ask() already checks the basic schema. Provider/protocol errors retain
      // their existing handling; only semantic validation gets planning repair.
      const candidate = await ask(role, task, schema);
      try { return validate(candidate); }
      catch (error) {
        const validationError = redact(error instanceof Error ? error.message : String(error));
        const evidence = { retry, attempt: retry + 1, maxRetries: config.maxPlanningRetries, validationError };
        state.failures.push({ timestamp: new Date().toISOString(), category: 'protocol', message: `${kind} semantic validation: ${validationError}` });
        emit(`${kind}.validation_failed`, actors.get(role)!.getId(), evidence);
        trace.checkpoint();
        if (retry >= config.maxPlanningRetries)
          throw new Error(`${kind} semantic validation exhausted after ${retry + 1} attempt(s) (${config.maxPlanningRetries} repair(s)): ${validationError}`);
        task = {
          ...initialTask, invariants,
          task: `repair-${kind}`,
          retryIndex: retry + 1,
          instruction: `Repair only the invalid ${kind} constraints identified by validationError. Preserve the valid parts and original requirements. Return the complete corrected ${kind} in the same schema. All listed invariants remain non-negotiable.`,
          [kind === 'contract' ? 'previousInvalidContract' : kind === 'plan' ? 'previousInvalidPlan' : 'previousInvalidReview']: candidate,
          validationError,
        };
        emit(`${kind}.repair_requested`, actors.get(role)!.getId(), { ...evidence, retry: retry + 1, attempt: retry + 2 });
      }
    }
  };

  const observer = createHuman({ name: 'Trace Observer (deterministic)', capabilities: ['observe'], handlers: [{
    specification: new OnEvent(() => true),
    processor: { apply({ event }) {
      if (state.terminal) return;
      const role = rolesById.get(event.producerId) ?? 'runtime';
      const turn = pending.get(role as Role);
      const payload = event.payload as any;
      if (event.type === 'message_received.started' && turn && payload.input?.context?.id === turn.contextId) turn.loopId = payload.loopId;
      if (event.type === 'inference.completed' && turn && turn.loopId === payload.loopId) {
        if (payload.rowResponse?.__factorySubmission === true) {
          trace.record({ role, participant: event.producerId, event: 'worker.submission_completed', ticketId: turn.ticket?.id ?? null });
          return; // Deterministic handoff consumes no provider call or tokens.
        }
        state.metrics.modelCalls++;
        const usage = payload.tokenUsage;
        if (usage) {
          state.metrics.meteredModelCalls++;
          state.metrics.knownInputTokens += usage.inputTokens;
          state.metrics.knownOutputTokens += usage.outputTokens;
          state.metrics.inputTokens = state.metrics.unmeteredModelCalls ? null : state.metrics.knownInputTokens;
          state.metrics.outputTokens = state.metrics.unmeteredModelCalls ? null : state.metrics.knownOutputTokens;
          if (!state.metrics.unmeteredModelCalls && config.inputPrice !== null && config.outputPrice !== null)
            state.metrics.estimatedCostUsd = ((state.metrics.inputTokens ?? 0) * config.inputPrice + (state.metrics.outputTokens ?? 0) * config.outputPrice) / 1_000_000;
        } else {
          state.metrics.unmeteredModelCalls++;
          state.metrics.inputTokens = null; state.metrics.outputTokens = null; state.metrics.estimatedCostUsd = null;
        }
        trace.record({ role, participant: event.producerId, event: event.type, ticketId: turn?.ticket?.id ?? null, model: modelFor(role as Role), tokenUsage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null, estimatedCostUsd: state.metrics.estimatedCostUsd });
      } else if (!/^(inference|function_call|message_received|interception|model\.|participant\.)/.test(event.type)) {
        trace.record({ role, participant: event.producerId, event: event.type, ticketId: payload.ticketId ?? null, retry: payload.retry ?? 0, detail: payload });
      }
    } },
  }] });
  rolesById.set(observer.getId(), 'observer'); api.join(observer);

  const answerHandler = on(['model.answer'], event => {
    if (state.terminal) return;
    const role = rolesById.get(event.producerId) as Role, turn = pending.get(role);
    const payload = event.payload as any;
    if (!turn || payload.loopId !== turn.loopId) return;
    let value: any;
    try { value = JSON.parse(payload.answer.content.text); }
    catch { throw new Error(`Invalid JSON from ${role}`); }
    if (value.__factoryFault) {
      const { category, message, statusCode, retryable, retriesHandled } = value.__factoryFault;
      state.failures.push({ timestamp: new Date().toISOString(), category, message, ...(turn.ticket ? { ticketId: turn.ticket.id } : {}) });
      trace.record({ role, event: `${category}.failed`, detail: { message, ...(category === 'provider' ? { statusCode: statusCode ?? null, retryable: retryable !== false } : {}) }, retry: turn.retry });
      if (category === 'provider' && !retriesHandled && retryable !== false && turn.retry < config.maxProviderRetries) { turn.retry++; launch(role, turn); return; }
      pending.delete(role); state.activeTurns.delete(role);
      turn.reject(new Error(`${category}: ${message}`)); fail(new Error(message), category, turn.ticket?.id); return;
    }
    try { value = turn.schema.parse(value); }
    catch (error) { fail(error, 'protocol', turn.ticket?.id); return; }
    pending.delete(role); state.activeTurns.delete(role);
    trace.record({ role, participant: event.producerId, event: 'turn.completed', phase: 'end', elapsedMs: Date.now() - turn.startedAt, ticketId: turn.ticket?.id ?? null, retry: turn.retry, model: modelFor(role) });
    turn.resolve(value);
  }, error => fail(error, 'protocol'));

  const accepted = (): ArtifactRecord[] => latestAccepted(state.artifacts);
  const ticketById = (id: string): EngineeringTicket => {
    const ticket = state.tickets.find(t => t.id === id);
    if (!ticket) throw new Error(`Unknown ticket: ${id}`);
    return ticket;
  };
  const schedule = (): void => {
    if (state.terminal || !state.engineeringPlan) return;
    for (const ticket of state.tickets) {
      if (ticket.status === 'BACKLOG' && ticket.dependencies.every(id => ['TESTING', 'DONE'].includes(ticketById(id).status))) moveTicket(ticket, 'READY');
    }
    for (const owner of ['developer-a', 'developer-b', 'qa'] as Owner[]) {
      if (state.tickets.some(t => t.owner === owner && t.status === 'IN_PROGRESS')) continue;
      const ticket = state.tickets.find(t => t.owner === owner && t.status === 'READY');
      if (ticket) { moveTicket(ticket, 'IN_PROGRESS'); emit('ticket.claimed', board.getId(), { ticketId: ticket.id, owner }); }
    }
    if (!state.integrationRunning && state.tickets.length && state.tickets.every(t => t.status === 'TESTING' || t.status === 'DONE')) {
      state.integrationRunning = true;
      emit('integration.requested', board.getId());
    }
  };
  const requestReview = (job: ReviewJob): void => { reviews.push(job); emit('review.requested', board.getId(), { ticketId: job.ticketId, mode: job.mode }); };
  const readArtifacts = (artifacts: ArtifactRecord[]): Record<string, string> => Object.fromEntries(artifacts.map(a => [a.file, readFileSync(a.path, 'utf8')]));

  const workTicket = async (owner: Owner, ticket: EngineeringTicket): Promise<void> => {
    candidateChecks.set(ticket.id, []);
    const workspace = safePath(work, `${owner}/${ticket.id}/attempt-${ticket.retryCount}`);
    scaffold(workspace, toolchain);
    integrateArtifacts(workspace, accepted());
    const prior = state.artifacts.filter(a => a.ticketId === ticket.id);
    const own = new Map<string, ArtifactRecord>();
    for (const artifact of prior) own.set(artifact.file, artifact);
    integrateArtifacts(workspace, [...own.values()]);
    const tools = workerTools({ workspace, ticket, toolchain, timeoutMs: config.commandTimeoutMs,
      expectedProductionFiles: state.engineeringPlan!.tickets.flatMap(t => t.ownedFiles),
      active: () => !state.terminal && state.activeTurns.get(owner)?.ticketId === ticket.id,
      record: (event, detail) => {
        if (event === 'write_file') candidateChecks.set(ticket.id, []);
        if ((event === 'run_check' || event === 'check.build_completed') && detail && typeof detail === 'object' && 'command' in detail)
          candidateChecks.get(ticket.id)!.push(detail as CommandResult);
        trace.record({ role: owner, event, ticketId: ticket.id, retry: ticket.retryCount, detail });
      },
    });
    if (owner === 'qa') emit('qa.started', actors.get(owner)!.getId(), { ticketId: ticket.id });
    await ask(owner, {
      task: ticket.parentTicketId || ticket.retryCount ? 'repair' : 'implement',
      contract: state.productContract, plan: state.engineeringPlan, ticket,
      executionEnvironment,
      evidence: state.testResults.at(-1) ?? null,
      reviewFeedback: state.reviews.filter(r => r.ticketId === ticket.id || r.ticketId === ticket.parentTicketId || r.ticketId.startsWith('CI-')).slice(-3),
      workspacePolicy: 'Your workspace is a fixed isolated snapshot. Other workers are genuinely concurrent, so their unfinished files are normally absent and will not appear during this turn. Implement the exact published interfaces without stubs. Once all owned files are written, call finish_work with your summary; integration will compile and test the combined artifacts. Never write summary.json or any summary file. Initial QA must derive tests from the contract without attempting to fix missing production code.',
      availableFiles: owner === 'qa' && !ticket.parentTicketId ? ['package.json', 'tsconfig.json'] : accepted().map(a => a.file),
    }, WorkerAnswerSchema, ticket, tools);
    if (state.terminal) return;
    const artifacts = captureArtifacts(workspace, ticket);
    state.artifacts.push(...artifacts);
    moveTicket(ticket, 'IN_REVIEW');
    emit(owner === 'qa' ? 'qa.completed' : 'ticket.completed', actors.get(owner)!.getId(), { ticketId: ticket.id, files: artifacts.map(a => a.file) });
    requestReview({ mode: 'review', ticketId: ticket.id, ticket });
    schedule();
  };

  const triage = (verdict: ReviewVerdict, verification: VerificationResult): void => {
    if (verdict.verdict !== 'changes_requested' || !verdict.blockingIssues.length) throw new Error('CI failure needs classified blocking issues');
    const groups = new Map<string, { source: EngineeringTicket; files: Set<string>; descriptions: string[] }>();
    for (const issue of verdict.blockingIssues) {
      for (const file of issue.files) {
        const source = state.tickets.find(t => !t.parentTicketId && t.ownedFiles.includes(file));
        if (!source || source.owner !== issue.likelyOwner) throw new Error(`Invalid triage ownership for ${file}`);
        const group = groups.get(source.id) ?? { source, files: new Set<string>(), descriptions: [] };
        group.files.add(file); group.descriptions.push(`${issue.reason}\nEvidence: ${issue.evidence}\nFix: ${issue.recommendedAction}`);
        groups.set(source.id, group);
      }
    }
    for (const { source, files, descriptions } of groups.values()) {
      if ((source.ciRetryCount ?? 0) >= config.maxRetries) { fail(new Error(`Retry limit reached for ${source.id}`), 'implementation', source.id); return; }
      source.ciRetryCount = (source.ciRetryCount ?? 0) + 1;
      const bug: EngineeringTicket = {
        id: `BUG-${String(++bugCounter).padStart(3, '0')}`, title: `Repair ${source.title}`,
        description: descriptions.join('\n\n'), owner: source.owner, status: 'READY', dependencies: [],
        ownedFiles: [...files], acceptanceCriteria: source.acceptanceCriteria,
        retryCount: 0, parentTicketId: source.id,
      };
      state.tickets.push(bug);
      emit('bug.created', actors.get('reviewer')!.getId(), { ticketId: bug.id, parentTicketId: source.id, owner: bug.owner, verificationAttempt: verification.attempt });
    }
    state.integrationRunning = false;
    emit('rework.requested', actors.get('reviewer')!.getId());
  };
  const drainReviews = async (): Promise<void> => {
    if (reviewing || state.terminal) return;
    reviewing = true;
    try {
      while (reviews.length && !state.terminal) {
        const job = reviews.shift()!;
        const ticket = job.ticket;
        const candidates = ticket ? state.artifacts.filter(a => a.ticketId === ticket.id && a.version === ticket.retryCount) : accepted();
        const verdict = await askValidated('reviewer', 'review', {
          task: job.mode, reviewMode: job.mode, ticketId: job.ticketId, ticket: ticket ?? null,
          contract: state.productContract, plan: state.engineeringPlan,
          executionEnvironment,
          ownership: state.tickets.filter(t => !t.parentTicketId).map(t => ({ id: t.id, owner: t.owner, files: t.ownedFiles })),
          artifacts: readArtifacts(candidates), previousArtifacts: ticket ? readArtifacts(accepted().filter(a => ticket.ownedFiles.includes(a.file))) : {},
          dependencyArtifacts: ticket ? readArtifacts(accepted().filter(a => !ticket.ownedFiles.includes(a.file))) : {},
          candidateChecks: ticket ? candidateChecks.get(ticket.id) ?? [] : [],
          verification: job.verification ?? null,
          previousVerification: job.mode === 'review' ? state.testResults.at(-1) ?? null : null,
        }, ReviewSchema, value => {
          const candidate = ReviewSchema.parse(value);
          if (candidate.ticketId !== job.ticketId) throw new Error(`Reviewer must return ticketId ${job.ticketId}`);
          if (candidate.verdict === 'approved' ? candidate.blockingIssues.length > 0 : candidate.blockingIssues.length === 0)
            throw new Error('Approved verdicts require no blocking issues; changes_requested requires at least one');
          if (job.mode === 'triage' && candidate.verdict !== 'changes_requested') throw new Error('Failed CI requires changes_requested triage');
          for (const issue of candidate.blockingIssues) {
            if (job.mode === 'review') {
              if (!ticket || issue.likelyOwner !== ticket.owner || issue.files.some(file => !ticket.ownedFiles.includes(file)))
                throw new Error(`Ordinary review of ${job.ticketId} may request repairs only from ${ticket?.owner} in ${ticket?.ownedFiles.join(', ')}. If current artifacts are correct and the failure belongs to another owner (including a wrong QA assertion), approve this ticket so integrated CI can triage that separate issue. Do not change correct production behavior to satisfy a test contradicting the contract.`);
            } else for (const file of issue.files) {
              const source = state.tickets.find(t => !t.parentTicketId && t.ownedFiles.includes(file));
              if (!source || source.owner !== issue.likelyOwner) throw new Error(`Invalid triage ownership for ${file}`);
            }
          }
          return candidate;
        }, [
          `Return the exact ticketId ${job.ticketId}.`,
          'Approved means no blocking issues; changes_requested means at least one concrete blocking issue.',
          job.mode === 'review' ? `Every blocking issue must belong to the current ticket owner ${ticket?.owner} and owned files ${ticket?.ownedFiles.join(', ')}. Other owners are handled by integrated CI triage, not by changing this ownership boundary.` : 'Triage every issue to the actual original owner and existing owned files; never approve failed CI.',
          'Preserve the Product Contract and correct tests; QA may correct a demonstrably false assertion, never weaken tests to accept broken software.',
        ]);
        if (state.terminal) return;
        if (verdict.ticketId !== job.ticketId || (verdict.verdict === 'approved' ? verdict.blockingIssues.length > 0 : verdict.blockingIssues.length === 0)) throw new Error('Reviewer returned inconsistent verdict');
        state.reviews.push(verdict);
        if (job.mode === 'triage') { triage(verdict, job.verification!); continue; }
        if (!ticket) throw new Error('Missing review ticket');
        if (verdict.verdict === 'approved') {
          for (const artifact of candidates) artifact.accepted = true;
          moveTicket(ticket, 'TESTING');
          emit('review.approved', actors.get('reviewer')!.getId(), { ticketId: ticket.id });
        } else {
          for (const issue of verdict.blockingIssues)
            if (issue.likelyOwner !== ticket.owner || issue.files.some(file => !ticket.ownedFiles.includes(file))) throw new Error('Ticket review requested a repair outside its ownership');
          moveTicket(ticket, 'FAILED');
          emit('review.changes_requested', actors.get('reviewer')!.getId(), { ticketId: ticket.id });
          if (!retryTicket(ticket, config.maxRetries)) { fail(new Error(`Review retry limit reached for ${ticket.id}`), 'implementation', ticket.id); return; }
        }
        schedule(); trace.checkpoint();
      }
    } finally { reviewing = false; }
  };

  const board = createHuman({ name: 'Project Board (deterministic)', capabilities: ['schedule-dag', 'track-state'], handlers: [
    on(['contract.ready'], () => { state.status = 'PLANNING'; trace.checkpoint(); }, fail),
    on(['plan.ready'], () => {
      state.status = 'BUILDING';
      state.tickets = state.engineeringPlan!.tickets.map(t => ({ ...t, status: 'BACKLOG', retryCount: 0 }));
      state.tickets.push({ id: 'QA-001', title: 'Adversarial contract tests', description: 'Independently test the contract against public interfaces.', owner: 'qa', status: 'BACKLOG', dependencies: [], ownedFiles: ['tests/contract.test.mjs'], acceptanceCriteria: state.productContract!.acceptanceCriteria.map(c => c.id), retryCount: 0 });
      schedule(); trace.checkpoint();
    }, fail),
    on(['rework.requested'], schedule, fail),
  ] });
  rolesById.set(board.getId(), 'board'); api.join(board);

  const handlers: Record<Role, import('@mozaik-ai/core').SituationHandler[]> = {
    pm: [on(['spec.received'], async () => {
      state.status = 'PLANNING';
      state.productContract = await askValidated('pm', 'contract', { task: 'contract', specification: state.originalSpec }, ContractSchema, parseContract, contractInvariants);
      emit('contract.ready', actors.get('pm')!.getId());
    }, error => fail(error, 'protocol'))],
    'tech-lead': [on(['contract.ready'], async () => {
      state.engineeringPlan = await askValidated('tech-lead', 'plan', { task: 'plan', contract: state.productContract, executionEnvironment }, PlanSchema, value => parsePlan(value, state.productContract!), planInvariants);
      emit('plan.ready', actors.get('tech-lead')!.getId());
    }, error => fail(error, 'protocol'))],
    'developer-a': [on(['ticket.claimed'], event => {
      const ticket = ticketById((event.payload as any).ticketId);
      if (ticket.owner === 'developer-a') return workTicket('developer-a', ticket);
    }, fail)],
    'developer-b': [on(['ticket.claimed'], event => {
      const ticket = ticketById((event.payload as any).ticketId);
      if (ticket.owner === 'developer-b') return workTicket('developer-b', ticket);
    }, fail)],
    qa: [on(['ticket.claimed'], event => {
      const ticket = ticketById((event.payload as any).ticketId);
      if (ticket.owner === 'qa') return workTicket('qa', ticket);
    }, fail)],
    reviewer: [on(['review.requested'], drainReviews, fail)],
  };
  for (const role of Object.keys(handlers) as Role[]) {
    const actor = createAgent({ name: role, capabilities: [role], instruction: instructions[role], tools: [], handlers: [...handlers[role], answerHandler] });
    actors.set(role, actor); rolesById.set(actor.getId(), role); api.join(actor);
  }

  const integrator = createHuman({ name: 'Integrator / CI (deterministic)', capabilities: ['integrate-artifacts', 'verify'], handlers: [on(['integration.requested'], async () => {
    state.status = 'TESTING';
    const attempt = state.testResults.length + 1;
    scaffold(output, toolchain);
    integrateArtifacts(output, accepted());
    const scaffoldHashes = new Map(['package.json', 'tsconfig.json'].map(file => [file, hashFile(safePath(output, file))]));
    emit('integration.completed', integrator.getId(), { attempt, files: accepted().map(a => a.file) });
    emit('verification.started', integrator.getId(), { attempt });
    const verification = await verifyProject(output, toolchain, config.commandTimeoutMs, attempt, command => trace.record({ role: 'ci', event: 'command.completed', phase: 'end', elapsedMs: command.elapsedMs, detail: command }), state.productContract!.projectType === 'http-api');
    if (state.terminal) return;
    state.testResults.push(verification);
    if (verification.passed) {
      // Guard against any edit during verification, including edits outside the factory.
      for (const artifact of accepted()) {
        if (hashFile(artifact.path) !== artifact.sha256 || hashFile(safePath(output, artifact.file)) !== artifact.sha256) {
          trace.record({ role: 'ci', event: 'integrity.failed', detail: { file: artifact.file, actor: 'unknown' } });
          throw new Error('Artifacts changed during deterministic verification');
        }
      }
      for (const [file, hash] of scaffoldHashes)
        if (hashFile(safePath(output, file)) !== hash) throw new Error(`CI-owned configuration changed during verification: ${file}`);
      for (const ticket of state.tickets) if (ticket.status === 'TESTING') moveTicket(ticket, 'DONE');
      emit('verification.passed', integrator.getId(), { attempt });
      writeFileSync(safePath(output, 'factory-verification.json'), JSON.stringify(verification, null, 2) + '\n');
      writeFileSync(safePath(output, 'product-contract.json'), JSON.stringify(state.productContract, null, 2) + '\n');
      writeFileSync(safePath(output, 'FACTORY.md'), `# Factory delivery\n\nRun: ${runId}\nMode: ${options.mode ?? 'live'}\n\nValidated with typecheck, build and Node tests.\n\nRun locally: npm install --ignore-scripts; npm run build; npm test.\nThe node_modules link reuses the factory toolchain and can be omitted when copying this project.\n\nSee product-contract.json and factory-verification.json for evidence.\n`);
      finish('COMPLETED');
    } else {
      emit('verification.failed', integrator.getId(), { attempt, category: verification.category });
      state.failures.push({ timestamp: new Date().toISOString(), category: verification.category === 'infrastructure' ? 'infrastructure' : 'implementation', message: `Verification attempt ${attempt} failed; see captured commands` });
      trace.checkpoint();
      if (verification.category === 'infrastructure') { fail(new Error('CI infrastructure failure; not classified as a product bug')); return; }
      state.status = 'RECOVERING';
      requestReview({ mode: 'triage', ticketId: `CI-${attempt}`, verification });
    }
  }, fail)] });
  rolesById.set(integrator.getId(), 'ci'); api.join(integrator);
  timer = setTimeout(() => fail(new Error('Factory run deadline exceeded')), config.runTimeoutMs);
  trace.record({ role: 'company', event: 'run.started', phase: 'start', detail: { mode: options.mode ?? 'live', provider: config.provider, maxOutputTokens: config.maxOutputTokens, modelTimeoutMs: config.modelTimeoutMs, reasoningEffort: config.reasoningEffort ?? null, models: Object.fromEntries((Object.keys(handlers) as Role[]).map(role => [role, modelFor(role)])) } });
  emit('spec.received', board.getId(), { bytes: Buffer.byteLength(state.originalSpec) });
  return completed;
}
