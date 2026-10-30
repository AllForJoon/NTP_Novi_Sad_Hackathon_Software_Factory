import { SituationSpecification, type SemanticEvent, type SituationContext, type SituationHandler } from '@mozaik-ai/core';
export class OnEvent extends SituationSpecification {
  constructor(private readonly match: (event: SemanticEvent) => boolean) { super(); }
  isSatisfiedBy({ event }: SituationContext): boolean { return this.match(event); }
}
export function on(types: string[], apply: (event: SemanticEvent) => void | Promise<void>, fail: (error: unknown) => void): SituationHandler {
  return {
    specification: new OnEvent(event => types.includes(event.type)),
    processor: { apply({ event }) {
      try { Promise.resolve(apply(event)).catch(fail); } catch (error) { fail(error); }
    } },
  };
}
