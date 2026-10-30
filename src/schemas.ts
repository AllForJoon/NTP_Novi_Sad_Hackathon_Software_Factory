import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const OwnerSchema = z.enum(['developer-a', 'developer-b', 'qa']);
export type Owner = z.infer<typeof OwnerSchema>;
export type Role = Owner | 'pm' | 'tech-lead' | 'reviewer';
export const ContractSchema = z.object({
  projectType: z.enum(['cli', 'http-api']),
  requirements: z.array(z.object({ id, description: z.string().min(1) }).strict()).min(1),
  acceptanceCriteria: z.array(z.object({ id, requirementIds: z.array(id).min(1), description: z.string().min(1) }).strict()).min(1),
  constraints: z.array(z.string()), ambiguities: z.array(z.string()), outOfScope: z.array(z.string()),
}).strict();
export type ProductContract = z.infer<typeof ContractSchema>;
export const TicketInputSchema = z.object({
  id, title: z.string().min(1), description: z.string().min(1),
  owner: z.enum(['developer-a', 'developer-b']), dependencies: z.array(id),
  ownedFiles: z.array(z.string().min(1)).min(1), acceptanceCriteria: z.array(id).min(1),
}).strict();
export const PlanSchema = z.object({
  architecture: z.string().min(1),
  interfaces: z.string().min(1),
  tickets: z.array(TicketInputSchema).min(2).max(12),
}).strict();
export type EngineeringPlan = z.infer<typeof PlanSchema>;
export type TicketStatus = 'BACKLOG' | 'READY' | 'IN_PROGRESS' | 'IN_REVIEW' | 'TESTING' | 'FAILED' | 'DONE';
export type EngineeringTicket = Omit<z.infer<typeof TicketInputSchema>, 'owner'> & {
  owner: Owner; status: TicketStatus; retryCount: number; parentTicketId?: string;
  reviewRetryCount?: number; ciRetryCount?: number;
};
export const ReviewSchema = z.object({
  ticketId: id, verdict: z.enum(['approved', 'changes_requested']),
  blockingIssues: z.array(z.object({
    reason: z.string().min(1), evidence: z.string(), recommendedAction: z.string().min(1),
    likelyOwner: OwnerSchema, files: z.array(z.string()).min(1),
  }).strict()),
}).strict();
export type ReviewVerdict = z.infer<typeof ReviewSchema>;
export const WorkerAnswerSchema = z.object({ summary: z.string().min(1) }).strict();

export function parseContract(value: unknown): ProductContract {
  const result = ContractSchema.parse(value);
  const requirements = new Set(result.requirements.map(r => r.id));
  const criteria = new Set(result.acceptanceCriteria.map(c => c.id));
  if (requirements.size !== result.requirements.length || criteria.size !== result.acceptanceCriteria.length)
    throw new Error('Duplicate contract IDs');
  for (const criterion of result.acceptanceCriteria)
    for (const ref of criterion.requirementIds)
      if (!requirements.has(ref)) throw new Error(`Unknown requirement: ${ref}`);
  for (const requirement of requirements)
    if (!result.acceptanceCriteria.some(c => c.requirementIds.includes(requirement)))
      throw new Error(`Requirement ${requirement} has no acceptance coverage`);
  return result;
}

export function productionPath(file: string): boolean {
  return /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/.test(file);
}

export function parsePlan(value: unknown, contract: ProductContract): EngineeringPlan {
  const plan = PlanSchema.parse(value);
  const ids = new Set(plan.tickets.map(t => t.id));
  if (new Set([...ids].map(x => x.toLowerCase())).size !== plan.tickets.length || [...ids].some(x => /^QA-001$|^BUG-/i.test(x)))
    throw new Error('Duplicate or reserved ticket ID');
  const criteria = new Set(contract.acceptanceCriteria.map(c => c.id));
  const files = new Set<string>();
  for (const ticket of plan.tickets) {
    for (const file of ticket.ownedFiles) {
      if (!productionPath(file) || files.has(file.toLowerCase())) throw new Error(`Invalid/conflicting ownership: ${file}`);
      files.add(file.toLowerCase());
    }
    for (const dependency of ticket.dependencies)
      if (!ids.has(dependency)) throw new Error(`Unknown dependency: ${dependency}`);
    for (const ref of ticket.acceptanceCriteria)
      if (!criteria.has(ref)) throw new Error(`Unknown acceptance criterion: ${ref}`);
  }
  for (const criterion of criteria)
    if (!plan.tickets.some(t => t.acceptanceCriteria.includes(criterion))) throw new Error(`Unassigned acceptance criterion: ${criterion}`);
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (ticketId: string): void => {
    if (visiting.has(ticketId)) throw new Error('Ticket DAG contains a cycle');
    if (visited.has(ticketId)) return;
    visiting.add(ticketId);
    for (const dep of plan.tickets.find(t => t.id === ticketId)!.dependencies) visit(dep);
    visiting.delete(ticketId); visited.add(ticketId);
  };
  for (const ticketId of ids) visit(ticketId);
  if (!['developer-a', 'developer-b'].every(owner => plan.tickets.some(t => t.owner === owner && !t.dependencies.length)))
    throw new Error('Plan needs independent initial tickets for both developers');
  if (!files.has('src/index.ts')) throw new Error('Plan must own the src/index.ts entry point');
  return plan;
}

export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
