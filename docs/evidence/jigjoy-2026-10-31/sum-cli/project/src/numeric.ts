/**
 * Numeric operand validation and normalized formatting helper for the `sum` CLI.
 *
 * Reliability contract:
 * - `parseOperand` trims the raw operand before anything else.
 * - Empty or whitespace-only operands are rejected after trimming.
 * - Only finite decimal literals are accepted: `/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/`.
 * - `NaN`, `Infinity`, non-numeric text, and other unsupported forms are rejected.
 * - Accepted operands return both a numeric value and its normalized text form.
 * - `formatSum` returns exact normalized numeric output text.
 *
 * Only Node.js built-ins (none required) and TypeScript are used.
 */

export type ParseOperandResult =
  | { readonly ok: true; readonly value: number; readonly normalized: string }
  | { readonly ok: false; readonly error: string };

/**
 * Matches an optionally signed finite decimal literal in normalized trimmed form.
 * Accepts: "1", "-2", "+3", "0", "1.0", "1.", ".5", "-2.5"
 * Rejects: "", "   ", "abc", "NaN", "Infinity", "1e3", "0x10"
 */
const DECIMAL_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Trim, validate, and normalize a single CLI operand.
 *
 * @param raw The raw operand string exactly as received from argv.
 * @returns An ok result with the numeric value and normalized text, or an
 *          error result describing why the operand was rejected.
 */
export function parseOperand(raw: string): ParseOperandResult {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  if (trimmed.length === 0) {
    return { ok: false, error: 'operand must not be empty' };
  }

  if (!DECIMAL_LITERAL.test(trimmed)) {
    return { ok: false, error: `operand is not a finite decimal number: ${trimmed}` };
  }

  const value = Number(trimmed);

  if (!Number.isFinite(value)) {
    return { ok: false, error: `operand is not a finite decimal number: ${trimmed}` };
  }

  return { ok: true, value, normalized: String(value) };
}

/**
 * Format a numeric sum as exact normalized numeric text.
 *
 * @param value The finite numeric sum.
 * @returns The canonical numeric string form (for example `3`, `-2`, `0`).
 */
export function formatSum(value: number): string {
  return String(value);
}
