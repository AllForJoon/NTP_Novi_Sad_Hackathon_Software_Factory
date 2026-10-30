import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(here);
const cliPath = join(projectRoot, 'dist', 'index.js');

/**
 * Run the built CLI through a real subprocess (no shell) and capture the
 * observable contract: exit code, stdout, stderr.
 */
function runCli(args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`CLI timed out after ${timeout}ms for args ${JSON.stringify(args)}`));
      }
    }, timeout);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('close', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      }
    });
  });
}

function assertSuccess(r, expectedStdout, label) {
  assert.equal(r.signal, null, `${label}: process should exit normally, not via signal`);
  assert.equal(r.code, 0, `${label}: expected exit code 0, got ${r.code} (stderr=${JSON.stringify(r.stderr)})`);
  assert.equal(r.stdout, expectedStdout, `${label}: stdout must be exactly ${JSON.stringify(expectedStdout)}`);
  assert.equal(r.stderr, '', `${label}: stderr should be empty on success`);
}

function assertFailure(r, label) {
  assert.equal(r.signal, null, `${label}: process should exit normally, not via signal`);
  assert.notEqual(r.code, 0, `${label}: expected non-zero exit code, got ${r.code}`);
  assert.equal(typeof r.code, 'number', `${label}: expected numeric exit code`);
  assert.equal(r.stdout, '', `${label}: stdout must be empty on error, got ${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.trim().length > 0, `${label}: expected a helpful message on stderr, got empty`);
}

// ---------------------------------------------------------------------------
// AC1 / AC2 / AC3: valid invocations -> exact normalized stdout, exit 0
// ---------------------------------------------------------------------------

test('AC1: `sum 1 2` prints exactly "3\\n" and exits 0', async () => {
  const r = await runCli(['sum', '1', '2']);
  assertSuccess(r, '3\n', 'sum 1 2');
});

test('AC2: `sum -2.5 0.5` prints exactly "-2\\n" and exits 0', async () => {
  const r = await runCli(['sum', '-2.5', '0.5']);
  assertSuccess(r, '-2\n', 'sum -2.5 0.5');
});

test('AC3: `sum 0 0` prints exactly "0\\n" and exits 0', async () => {
  const r = await runCli(['sum', '0', '0']);
  assertSuccess(r, '0\n', 'sum 0 0');
});

test('AC3: `sum 1.0 1` prints exactly "2\\n" (decimal input normalized numerically) and exits 0', async () => {
  const r = await runCli(['sum', '1.0', '1']);
  assertSuccess(r, '2\n', 'sum 1.0 1');
});

test('R2: negative operands both sides sum numerically (sum -3 -4 -> "-7\\n")', async () => {
  const r = await runCli(['sum', '-3', '-4']);
  assertSuccess(r, '-7\n', 'sum -3 -4');
});

test('R2: decimal normalization emits normalized numeric text (sum 2.50 0.50 -> "3\\n")', async () => {
  const r = await runCli(['sum', '2.50', '0.50']);
  assertSuccess(r, '3\n', 'sum 2.50 0.50');
});

test('R2: larger boundary values remain exact (sum 999999 1 -> "1000000\\n")', async () => {
  const r = await runCli(['sum', '999999', '1']);
  assertSuccess(r, '1000000\n', 'sum 999999 1');
});

// ---------------------------------------------------------------------------
// Normalization end-to-end: the plan states operands are trimmed before
// validation and "1.0" normalizes to "1"; " 1.0 " likewise normalizes to "1".
// ---------------------------------------------------------------------------

test('normalization: `sum " 1.0 " 0` trims operand and prints exactly "1\\n"', async () => {
  const r = await runCli(['sum', ' 1.0 ', '0']);
  assertSuccess(r, '1\n', 'sum " 1.0 " 0');
});

test('normalization: `sum " 1 " " 2 "` trims both operands and prints exactly "3\\n"', async () => {
  const r = await runCli(['sum', ' 1 ', ' 2 ']);
  assertSuccess(r, '3\n', 'sum " 1 " " 2 "');
});

// ---------------------------------------------------------------------------
// AC4: wrong number of operands -> non-zero, stderr, no stdout
// ---------------------------------------------------------------------------

test('AC4: `sum 1` (missing operand) fails with non-zero exit and no stdout', async () => {
  const r = await runCli(['sum', '1']);
  assertFailure(r, 'sum 1');
});

test('AC4: `sum 1 2 3` (extra operand) fails with non-zero exit and no stdout', async () => {
  const r = await runCli(['sum', '1', '2', '3']);
  assertFailure(r, 'sum 1 2 3');
});

test('R3: `sum` with no operands fails with non-zero exit and no stdout', async () => {
  const r = await runCli(['sum']);
  assertFailure(r, 'sum');
});

// ---------------------------------------------------------------------------
// AC5: invalid operands -> non-zero, stderr, no stdout
// ---------------------------------------------------------------------------

test('AC5: empty operand `sum "" 2` fails, no stdout', async () => {
  const r = await runCli(['sum', '', '2']);
  assertFailure(r, 'sum "" 2');
});

test('AC5: whitespace-only operand `sum "   " 2` fails, no stdout', async () => {
  const r = await runCli(['sum', '   ', '2']);
  assertFailure(r, 'sum "   " 2');
});

test('AC5: non-numeric operand `sum abc 2` fails, no stdout', async () => {
  const r = await runCli(['sum', 'abc', '2']);
  assertFailure(r, 'sum abc 2');
});

test('AC5: `sum NaN 2` fails, no stdout', async () => {
  const r = await runCli(['sum', 'NaN', '2']);
  assertFailure(r, 'sum NaN 2');
});

test('AC5: `sum Infinity 2` fails, no stdout', async () => {
  const r = await runCli(['sum', 'Infinity', '2']);
  assertFailure(r, 'sum Infinity 2');
});

test('AC5: second-operand invalid `sum 2 abc` fails, no stdout', async () => {
  const r = await runCli(['sum', '2', 'abc']);
  assertFailure(r, 'sum 2 abc');
});

test('R4: `sum -Infinity 0` fails, no stdout', async () => {
  const r = await runCli(['sum', '-Infinity', '0']);
  assertFailure(r, 'sum -Infinity 0');
});

// ---------------------------------------------------------------------------
// AC6: no command / unknown command -> non-zero, stderr, no stdout
// ---------------------------------------------------------------------------

test('AC6: no command at all fails with non-zero exit and no stdout', async () => {
  const r = await runCli([]);
  assertFailure(r, 'no args');
});

test('AC6: unknown command `add 1 2` fails with non-zero exit and no stdout', async () => {
  const r = await runCli(['add', '1', '2']);
  assertFailure(r, 'add 1 2');
});

test('AC6: unknown command with valid-looking operands `mul 2 3` fails, no stdout', async () => {
  const r = await runCli(['mul', '2', '3']);
  assertFailure(r, 'mul 2 3');
});

// ---------------------------------------------------------------------------
// AC7: TypeScript implementation using only Node.js built-in modules at runtime
// ---------------------------------------------------------------------------

function extractSpecifiers(src) {
  const specs = new Set();
  const patterns = [
    /(?:^|[^.\w])from\s*['"]([^'"]+)['"]/g, // import ... from 'x'; export ... from 'x'
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g, // side-effect import
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      specs.add(m[1]);
    }
  }
  return [...specs];
}

test('AC7: package.json declares no runtime third-party dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  const runtimeDeps = Object.keys(pkg.dependencies || {});
  assert.deepEqual(runtimeDeps, [], `runtime dependencies must be empty, found ${JSON.stringify(runtimeDeps)}`);
});

test('AC7: project is TypeScript (src/*.ts present) and build output exists', () => {
  assert.ok(existsSync(join(projectRoot, 'src', 'index.ts')), 'src/index.ts must exist (TypeScript entry)');
  assert.ok(existsSync(cliPath), 'dist/index.js must exist after `npm run build`');
});

test('AC7: every import in compiled dist uses only Node.js built-ins or relative paths', () => {
  const distDir = join(projectRoot, 'dist');
  assert.ok(existsSync(distDir), 'dist directory must exist after build');
  const jsFiles = readdirSync(distDir).filter((f) => f.endsWith('.js'));
  assert.ok(jsFiles.length >= 1, 'dist must contain at least one .js file');

  for (const file of jsFiles) {
    const src = readFileSync(join(distDir, file), 'utf8');
    for (const spec of extractSpecifiers(src)) {
      const isRelative = spec.startsWith('.') || spec.startsWith('/');
      const builtin = isBuiltin(spec);
      assert.ok(
        isRelative || builtin,
        `non-built-in import "${spec}" found in dist/${file}`,
      );
    }
  }
});
