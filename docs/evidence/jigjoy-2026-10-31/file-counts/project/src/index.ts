import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { computeStats } from './stats.js';

export interface CliIo {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  isFile(path: string): Promise<boolean>;
  readFileUtf8(path: string): Promise<string>;
}

const USAGE = 'usage: node dist/index.js stats <path>';

function errorMessage(error: unknown, path: string): string {
  const reason =
    error instanceof Error && error.message.length > 0
      ? error.message
      : String(error);
  return `error: cannot read file "${path}": ${reason}`;
}

export async function runCli(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.length !== 2 || args[0] !== 'stats') {
    io.writeStderr(`error: invalid arguments. ${USAGE}\n`);
    return 2;
  }

  const path = args[1];

  let readable: boolean;
  try {
    readable = await io.isFile(path);
  } catch {
    readable = false;
  }
  if (!readable) {
    io.writeStderr(`error: not a readable file: "${path}"\n`);
    return 1;
  }

  let text: string;
  try {
    text = await io.readFileUtf8(path);
  } catch (error) {
    io.writeStderr(`${errorMessage(error, path)}\n`);
    return 1;
  }

  const stats = computeStats(text);
  io.writeStdout(
    JSON.stringify({
      lines: stats.lines,
      words: stats.words,
      characters: stats.characters,
    }) + '\n',
  );
  return 0;
}

const defaultIo: CliIo = {
  writeStdout(text: string): void {
    process.stdout.write(text);
  },
  writeStderr(text: string): void {
    process.stderr.write(text);
  },
  async isFile(path: string): Promise<boolean> {
    try {
      const info = await stat(path);
      return info.isFile();
    } catch {
      return false;
    }
  },
  async readFileUtf8(path: string): Promise<string> {
    return readFile(path, 'utf8');
  },
};

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runCli(process.argv.slice(2), defaultIo)
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('error: unexpected failure\n');
      process.exitCode = 1;
    });
}
