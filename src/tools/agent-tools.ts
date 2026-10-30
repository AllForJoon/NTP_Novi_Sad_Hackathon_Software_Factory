import { z } from 'zod';
import type { Tool } from '@mozaik-ai/core';
import type { EngineeringTicket } from '../schemas.js';
import { inferenceJsonSchema } from '../runtime/inference-schema.js';
import { listFiles, readBounded, writeOwned } from './workspace.js';
import { redact, runNode } from './commands.js';
import { resolve } from 'node:path';

export function workerTools(options: {
  workspace: string; ticket: EngineeringTicket; toolchain: string; timeoutMs: number;
  active: () => boolean; record: (action: string, detail: unknown) => void;
}): Tool[] {
  const make = (name: string, description: string, schema: z.ZodType, fn: (data: any) => unknown | Promise<unknown>): Tool => ({
    type: 'function', name, description, strict: true, parameters: inferenceJsonSchema(schema),
    async invoke(input: unknown) {
      if (!options.active()) return { error: 'Turn is no longer active' };
      try {
        const args = schema.parse(input);
        const result = await fn(args);
        options.record(name, name === 'write_file' ? { path: (args as { path: string }).path } : name === 'run_check' ? result : { success: true });
        return result;
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        options.record('tool.denied', { tool: name, error: message });
        return { error: message };
      }
    },
  });
  return [
    make('list_files', 'List candidate files in your isolated workspace.', z.object({}).strict(), () => ({ files: listFiles(options.workspace) })),
    make('read_file', 'Read a bounded candidate file. Paths are relative to the workspace.', z.object({ path: z.string() }).strict(), ({ path }) => ({ content: readBounded(options.workspace, path) })),
    make('search_files', 'Search workspace text using a literal substring.', z.object({ text: z.string().min(1).max(200) }).strict(), ({ text }) => ({ matches: listFiles(options.workspace).flatMap(path => readBounded(options.workspace, path).split('\n').flatMap((line, i) => line.includes(text) ? [{ path, line: i + 1, text: line.slice(0, 300) }] : [])).slice(0, 100) })),
    make('write_file', 'Write a complete UTF-8 file owned by your ticket. Other paths are denied.', z.object({ path: z.string(), content: z.string() }).strict(), ({ path, content }) => { writeOwned(options.workspace, path, content, options.ticket); return { written: path }; }),
    make('run_check', 'Run a fixed typecheck/build/test command. Incomplete dependencies may fail before integration.', z.object({ check: z.enum(['typecheck', 'build', 'test']) }).strict(), ({ check }) => runNode(options.workspace, check === 'test' ? ['--test', 'tests/contract.test.mjs'] : [resolve(options.toolchain, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', ...(check === 'typecheck' ? ['--noEmit'] : [])], options.timeoutMs)),
  ];
}
