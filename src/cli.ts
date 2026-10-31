import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runFactory } from './factory/company.js';
import { DemoRunner } from './testing/demo-runner.js';
import { redact } from './tools/commands.js';
import { availableModels } from './config.js';

loadEnv({ quiet: true });
try {
  const { values, positionals } = parseArgs({ options: { demo: { type: 'boolean' }, 'demo-recovery': { type: 'boolean' }, 'list-models': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  if (values.help) {
    console.log('Usage: npm run factory -- <spec.md> [--demo | --demo-recovery]\n       npm run models\nLive mode requires a selected FACTORY_MODEL and its provider API key (or optional JigJoy login). Offline flags support only specs/examples/sum-cli.md.');
  } else if (values['list-models']) {
    if (positionals.length || values.demo || values['demo-recovery']) throw new Error('Use --list-models alone, without a spec or demo flag.');
    console.log(['Provider\tModel ID\tAPI key variable', ...availableModels().map(model => `${model.provider}\t${model.model}\t${model.apiKeyEnv}`)].join('\n'));
    console.log('\nThese are model IDs supported by the pinned Mozaik runtime; your provider account must grant access. JigJoy hosted model aliases are account-specific and are not listed here.');
  } else {
    if (positionals.length !== 1 || (values.demo && values['demo-recovery'])) throw new Error('Provide one specification path and at most one demo flag. Use --help for usage.');
    const root = process.cwd(), spec = readFileSync(resolve(root, positionals[0]!), 'utf8');
    const demo = Boolean(values.demo || values['demo-recovery']);
    if (demo) {
      const fixture = readFileSync(resolve(root, 'specs/examples/sum-cli.md'), 'utf8');
      if (spec.replaceAll('\r\n', '\n').trim() !== fixture.replaceAll('\r\n', '\n').trim()) throw new Error('Offline fixture supports only the bundled Sum CLI specification. Run without demo flags for other specs.');
      console.log('OFFLINE FIXTURE: scripted model responses; real Mozaik runtime, tools, compilation and tests.');
    }
    const result = await runFactory({ root, spec, ...(demo ? { runner: new DemoRunner({ defect: Boolean(values['demo-recovery']) }), mode: 'offline-fixture' as const } : {}) });
    console.log(`\n${result.state.status}\nRun: ${result.state.runId}\nProject: ${result.outputDirectory}\nTrace: ${result.trace.directory}`);
    if (result.state.status !== 'COMPLETED') {
      console.error(result.state.failures.at(-1)?.message ?? 'Factory did not pass final verification');
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
