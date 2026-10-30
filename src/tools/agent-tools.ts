import { z } from 'zod';
import type { Tool } from '@mozaik-ai/core';
import { WorkerAnswerSchema, type EngineeringTicket } from '../schemas.js';
import { inferenceJsonSchema } from '../runtime/inference-schema.js';
import { captureArtifacts, listFiles, readBounded, writeOwned } from './workspace.js';
import { redact, runNode } from './commands.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export function workerTools(options: {
  workspace: string; ticket: EngineeringTicket; toolchain: string; timeoutMs: number;
  active: () => boolean; record: (action: string, detail: unknown) => void;
  expectedProductionFiles?: string[];
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
    make('finish_work', 'Submit your written owned files and summary for independent review. Use this once all owned files are written; integration will verify the complete project. Do not write summary files or wait for concurrent workers.', WorkerAnswerSchema, ({ summary }) => {
      captureArtifacts(options.workspace, options.ticket);
      return { __factorySubmission: true, summary };
    }),
    make('list_files', 'List candidate files in your isolated workspace.', z.object({}).strict(), () => ({ files: listFiles(options.workspace) })),
    make('read_file', 'Read a bounded candidate file. Paths are relative to the workspace.', z.object({ path: z.string() }).strict(), ({ path }) => ({ content: readBounded(options.workspace, path) })),
    make('search_files', 'Search workspace text using a literal substring.', z.object({ text: z.string().min(1).max(200) }).strict(), ({ text }) => ({ matches: listFiles(options.workspace).flatMap(path => readBounded(options.workspace, path).split('\n').flatMap((line, i) => line.includes(text) ? [{ path, line: i + 1, text: line.slice(0, 300) }] : [])).slice(0, 100) })),
    make('write_file', 'Write a complete UTF-8 file owned by your ticket. Other paths are denied.', z.object({ path: z.string(), content: z.string() }).strict(), ({ path, content }) => { writeOwned(options.workspace, path, content, options.ticket); return { written: path }; }),
    make('run_check', 'Run a fixed typecheck/build/test command when the production snapshot is complete; otherwise report deferred verification, never a pass.', z.object({ check: z.enum(['typecheck', 'build', 'test']) }).strict(), async ({ check }) => {
      const missingFiles = (options.expectedProductionFiles ?? []).filter(file => !existsSync(resolve(options.workspace, file)));
      if (missingFiles.length) return {
        status: 'deferred', passed: false, missingFiles,
        instruction: 'This isolated snapshot is incomplete. Other workers submit their files independently; they do not appear here during your turn. Write all your owned files, preserve the published interfaces and submit your summary. Do not add stubs, change interfaces or weaken tests to make this snapshot pass. Full deterministic verification runs after integration.',
      };
      const compiler = [resolve(options.toolchain, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'];
      if (check !== 'test') return runNode(options.workspace, [...compiler, ...(check === 'typecheck' ? ['--noEmit'] : [])], options.timeoutMs);
      const build = await runNode(options.workspace, compiler, options.timeoutMs);
      options.record('check.build_completed', build);
      if (build.exitCode !== 0 || build.error || build.timedOut || build.signal) return build;
      return runNode(options.workspace, ['--test', 'tests/contract.test.mjs'], options.timeoutMs);
    }),
  ];
}
