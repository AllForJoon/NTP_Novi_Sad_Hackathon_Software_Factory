import { RuntimeState } from '@mozaik-ai/core';
import type { EngineeringPlan, EngineeringTicket, ProductContract, ReviewVerdict, Role, TicketStatus } from './schemas.js';

export type ProjectStatus = 'RECEIVED' | 'PLANNING' | 'BUILDING' | 'REVIEWING' | 'TESTING' | 'RECOVERING' | 'COMPLETED' | 'FAILED';
export interface HumanIntervention { timestamp: string; reason: string; description: string }
export interface ArtifactRecord { ticketId: string; owner: string; file: string; path: string; sha256: string; version: number; accepted: boolean }
export interface CommandResult {
  command: string; cwd: string; exitCode: number | null; signal: string | null;
  stdout: string; stderr: string; elapsedMs: number; timedOut: boolean; error: string | null;
}
export interface VerificationResult {
  attempt: number; passed: boolean; category: 'passed' | 'implementation' | 'infrastructure';
  commands: CommandResult[]; timestamp: string;
}
export interface FailureRecord { timestamp: string; category: 'implementation' | 'provider' | 'infrastructure' | 'protocol'; message: string; ticketId?: string }
export interface RunMetrics {
  modelCalls: number; meteredModelCalls: number; unmeteredModelCalls: number;
  knownInputTokens: number; knownOutputTokens: number;
  inputTokens: number | null; outputTokens: number | null;
  estimatedCostUsd: number | null; humanInterventionCount: number;
}
export class EngineeringState extends RuntimeState {
  productContract: ProductContract | null = null;
  engineeringPlan: EngineeringPlan | null = null;
  tickets: EngineeringTicket[] = [];
  artifacts: ArtifactRecord[] = [];
  reviews: ReviewVerdict[] = [];
  testResults: VerificationResult[] = [];
  failures: FailureRecord[] = [];
  status: ProjectStatus = 'RECEIVED';
  metrics: RunMetrics = { modelCalls: 0, meteredModelCalls: 0, unmeteredModelCalls: 0, knownInputTokens: 0, knownOutputTokens: 0, inputTokens: null, outputTokens: null, estimatedCostUsd: null, humanInterventionCount: 0 };
  humanInterventions: HumanIntervention[] = [];
  activeTurns = new Map<Role, { ticketId?: string; startedAt: number; retry: number }>();
  integrationRunning = false;
  constructor(readonly runId: string, readonly originalSpec: string) { super(); }
  get terminal(): boolean { return this.status === 'COMPLETED' || this.status === 'FAILED'; }
  recordHumanIntervention(reason: string, description: string): void {
    this.humanInterventions.push({ timestamp: new Date().toISOString(), reason, description });
    this.metrics.humanInterventionCount = this.humanInterventions.length;
  }
  snapshot(): Record<string, unknown> {
    const { participants: _participants, activeTurns, ...data } = this;
    return { ...data, activeTurns: Object.fromEntries(activeTurns) };
  }
}
const transitions: Record<TicketStatus, TicketStatus[]> = {
  BACKLOG: ['READY'], READY: ['IN_PROGRESS'], IN_PROGRESS: ['IN_REVIEW', 'FAILED'],
  IN_REVIEW: ['TESTING', 'FAILED'], TESTING: ['DONE', 'FAILED'], FAILED: ['READY'], DONE: [],
};
export function moveTicket(ticket: EngineeringTicket, next: TicketStatus): void {
  if (!transitions[ticket.status].includes(next)) throw new Error(`Invalid ticket transition ${ticket.status} -> ${next}`);
  ticket.status = next;
}
export function retryTicket(ticket: EngineeringTicket, limit: number): boolean {
  if ((ticket.reviewRetryCount ?? 0) >= limit) return false;
  ticket.reviewRetryCount = (ticket.reviewRetryCount ?? 0) + 1;
  ticket.retryCount++;
  moveTicket(ticket, 'READY');
  return true;
}
