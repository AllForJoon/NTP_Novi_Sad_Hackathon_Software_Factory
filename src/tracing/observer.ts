import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redact } from '../tools/commands.js';
import type { EngineeringState } from '../state.js';
export interface TraceRecord {
  timestamp: string; runId: string; participant: string; role: string;
  ticketId: string | null; event: string; phase: 'start' | 'end' | 'instant'; elapsedMs: number | null;
  retry: number; model: string | null; tokenUsage: { inputTokens: number; outputTokens: number } | null;
  estimatedCostUsd: number | null; humanInterventionCount: number; detail: unknown;
}
export class TraceObserver {
  readonly directory: string;
  readonly records: TraceRecord[] = [];
  private readonly startedAt = Date.now();
  constructor(root: string, readonly state: EngineeringState, private readonly quiet = false) {
    this.directory = resolve(root, 'traces', state.runId);
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(resolve(this.directory, 'events.jsonl'), '', { flag: 'wx' });
    writeFileSync(resolve(this.directory, 'activity.log'), '', { flag: 'wx' });
  }
  record(input: Partial<TraceRecord> & Pick<TraceRecord, 'role' | 'event'>): void {
    const record: TraceRecord = {
      timestamp: new Date().toISOString(), runId: this.state.runId, participant: input.role,
      ticketId: null, phase: 'instant', elapsedMs: null, retry: 0, model: null,
      tokenUsage: null, estimatedCostUsd: null, humanInterventionCount: this.state.humanInterventions.length,
      detail: null, ...input,
    };
    const clean = JSON.parse(redact(JSON.stringify(record))) as TraceRecord;
    this.records.push(clean);
    appendFileSync(resolve(this.directory, 'events.jsonl'), JSON.stringify(clean) + '\n');
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(2).padStart(7);
    const line = `${elapsed}s  ${record.role.padEnd(12)} ${record.ticketId ?? ''} ${record.event}${record.elapsedMs === null ? '' : ` (${record.elapsedMs} ms)`}\n`;
    appendFileSync(resolve(this.directory, 'activity.log'), line);
    if (!this.quiet) process.stdout.write(line);
  }
  checkpoint(): void {
    writeFileSync(resolve(this.directory, 'state.json'), redact(JSON.stringify(this.state.snapshot(), null, 2)) + '\n');
  }
}
