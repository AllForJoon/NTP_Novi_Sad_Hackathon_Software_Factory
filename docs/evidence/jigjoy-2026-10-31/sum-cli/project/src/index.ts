import { pathToFileURL } from 'node:url';
import { parseOperand, formatSum } from './numeric.js';

const USAGE = 'Error: usage: sum <a> <b>\n';
const OPERAND_ERROR =
  'Error: operands must be finite decimal numbers; usage: sum <a> <b>\n';

/**
 * CLI entry point. Writes the result (or a helpful error) and returns the
 * intended process exit code.
 */
export function main(argv: readonly string[]): number {
  const [command, ...operands] = argv;

  if (command !== 'sum' || operands.length !== 2) {
    process.stderr.write(USAGE);
    return 1;
  }

  const a = parseOperand(operands[0]);
  const b = parseOperand(operands[1]);
  if (!a.ok || !b.ok) {
    process.stderr.write(OPERAND_ERROR);
    return 1;
  }

  process.stdout.write(`${formatSum(a.value + b.value)}\n`);
  return 0;
}

const entryArg = process.argv[1];
if (
  typeof entryArg === 'string' &&
  import.meta.url === pathToFileURL(entryArg).href
) {
  process.exitCode = main(process.argv.slice(2));
}
