// Adversarial contract tests for the `stats` CLI (QA-001).
//
// Derived from the Product Contract (R1-R8, AC1-AC15) and the Tech Lead's
// published interfaces. The implementation is treated as a black box and is
// reached ONLY through CLI subprocesses: `node dist/index.js ...` with
// shell:false. No production module is imported or modified here.
//
// NOTE on AC8: the acceptance text claims `a\r\nb` reports "5 characters".
// That contradicts R3 (characters = Unicode code-point count): the string
// 'a','\r','\n','b' is exactly 4 code points. Every expected value below is
// independently re-checked against the literal fixture code points via
// verifyFixture(), so a wrong constant (like "5") cannot slip through. The
// accurate expectation asserted here is 4.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { builtinModules } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = path.join(projectRoot, 'dist', 'index.js');
const CLI_TIMEOUT_MS = 20000;

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-contract-'));
after(() => {
  try {
    fs.rmSync(baseDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
});

// Run the built CLI with bounded wait. Returns { code, signal, stdout, stderr }.
function runCli(args, options = {}) {
  const cwd = options.cwd || projectRoot;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [distEntry, ...args], {
        shell: false,
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(
        reject,
        new Error(`CLI timed out after ${CLI_TIMEOUT_MS}ms; args=${JSON.stringify(args)}`),
      );
    }, CLI_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code, signal) => finish(resolve, { code, signal, stdout, stderr }));
  });
}

// Write `content` to a fresh, unique file and return its path.
function makeFixture(label, content) {
  const dir = fs.mkdtempSync(path.join(baseDir, label.replace(/[^a-z0-9]/gi, '_') + '-'));
  const file = path.join(dir, 'input.txt');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// Independent reference derived only from the contract, computed from the
// literal fixture code points. Used to guard the declared expected values so a
// wrong constant is caught rather than encoded.
function refStats(text) {
  const characters = [...text].length; // Unicode code points
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/u).length;
  let lines;
  if (text === '') {
    lines = 0;
  } else {
    let lf = 0;
    for (const ch of text) if (ch === '\n') lf += 1;
    lines = lf + (text.endsWith('\n') ? 0 : 1);
  }
  return { lines, words, characters };
}

function verifyFixture(content, expected) {
  assert.deepEqual(
    refStats(content),
    expected,
    `declared expected values disagree with independent code-point reference for ${JSON.stringify(content)}`,
  );
}

// Validate the successful stdout contract (R2, AC1, AC2) and return the object.
function assertSuccessfulStats(result) {
  assert.equal(result.code, 0, `expected exit code 0; stderr=${JSON.stringify(result.stderr)}`);
  assert.equal(typeof result.stdout, 'string');
  assert.ok(result.stdout.endsWith('\n'), 'stdout must be terminated by a newline');
  assert.equal(
    (result.stdout.match(/\n/g) || []).length,
    1,
    'stdout must contain exactly one line ending',
  );

  const body = result.stdout.slice(0, -1); // drop the single trailing newline
  assert.ok(!body.includes('\n'), 'the JSON object must occupy a single line');

  let obj;
  assert.doesNotThrow(() => {
    obj = JSON.parse(body);
  }, 'stdout must be a single valid JSON object');
  assert.equal(typeof obj, 'object');
  assert.ok(obj !== null && !Array.isArray(obj), 'JSON root must be an object');
  assert.deepEqual(
    Object.keys(obj).sort(),
    ['characters', 'lines', 'words'],
    'object must expose exactly lines, words, characters and nothing else',
  );
  for (const key of ['lines', 'words', 'characters']) {
    assert.ok(Object.hasOwn(obj, key), `${key} must be an own property of the emitted JSON object`);
    assert.equal(typeof obj[key], 'number', `${key} must be a number`);
    assert.ok(Number.isInteger(obj[key]), `${key} must be an integer`);
    assert.ok(obj[key] >= 0, `${key} must be non-negative`);
  }
  return obj;
}

function assertStats(result, expected) {
  const obj = assertSuccessfulStats(result);
  assert.deepEqual(
    { lines: obj.lines, words: obj.words, characters: obj.characters },
    expected,
    `unexpected stats; stdout=${JSON.stringify(result.stdout)}`,
  );
  return obj;
}

// Validate a failure result (R6): nonzero exit, empty stdout, nonempty stderr.
function assertCliError(result) {
  assert.notEqual(
    result.code,
    0,
    `expected nonzero exit; got ${result.code}; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  );
  assert.equal(result.stdout, '', 'stdout must be empty on failure');
  assert.ok(
    typeof result.stderr === 'string' && result.stderr.trim().length > 0,
    'stderr must carry a useful, non-empty message on failure',
  );
}

const builtins = new Set(builtinModules);

// Modules that would indicate networking. Rejected explicitly so that a
// blanket "any node: specifier is fine" allowance cannot let R8/AC15 slip.
const FORBIDDEN_NETWORK_MODULES = new Set([
  'http',
  'https',
  'http2',
  'http3',
  'net',
  'tls',
  'dns',
  'dgram',
  'dns/promises',
  'undici',
]);

function bareSpecifierName(spec) {
  const stripped = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
  return stripped;
}

function isBuiltinSpecifier(spec) {
  const bare = bareSpecifierName(spec);
  if (spec.startsWith('node:')) return true;
  return builtins.has(bare) || builtins.has(bare.split('/')[0]);
}

function isForbiddenNetworkSpecifier(spec) {
  const bare = bareSpecifierName(spec);
  if (FORBIDDEN_NETWORK_MODULES.has(bare)) return true;
  return FORBIDDEN_NETWORK_MODULES.has(bare.split('/')[0]);
}

function extractImportSpecifiers(src) {
  const specs = new Set();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(?\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

// Detect a bare global fetch(...) call (not a method like `foo.fetch(`).
const GLOBAL_FETCH_RE = /(^|[^.\w$])fetch\s*\(/;

// Recursively-ish snapshot of a directory's entries including file contents,
// so any created, deleted, or modified file is detected.
function snapshotDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        const buf = fs.readFileSync(full);
        return `${entry.name}:file:${buf.length}:${buf.toString('base64')}`;
      }
      if (entry.isDirectory()) return `${entry.name}:dir`;
      return `${entry.name}:other`;
    })
    .sort();
}

// --- AC1 / AC2 : success stdout shape -------------------------------------
test('AC1/AC2: success emits exactly one compact JSON line with numeric fields and a trailing newline', async () => {
  const content = 'The quick brown fox\n';
  const expected = { lines: 1, words: 4, characters: 20 };
  verifyFixture(content, expected);

  const result = await runCli(['stats', makeFixture('ac1', content)]);
  const obj = assertStats(result, expected);

  // Exact key order mandated by the contract (AC6 literal / plan).
  assert.deepEqual(Object.keys(obj), ['lines', 'words', 'characters']);
  // Compact, canonical serialization: body === JSON.stringify(obj).
  assert.equal(result.stdout.slice(0, -1), JSON.stringify(obj));
});

// --- AC6 : empty file ------------------------------------------------------
test('AC6: empty file yields {lines:0,words:0,characters:0} on one line with exit 0', async () => {
  const content = '';
  const expected = { lines: 0, words: 0, characters: 0 };
  verifyFixture(content, expected);

  const result = await runCli(['stats', makeFixture('ac6', content)]);
  const obj = assertStats(result, expected);
  assert.deepEqual(obj, { lines: 0, words: 0, characters: 0 });
  assert.deepEqual(Object.keys(obj), ['lines', 'words', 'characters']);
});

// --- AC3 : Unicode code points --------------------------------------------
test('AC3: characters counts Unicode code points, not UTF-16 units or UTF-8 bytes', async () => {
  const content = 'a\u{1F600}\u00E9'; // 'a', '😀' (U+1F600), 'é' (U+00E9)
  const expected = { lines: 1, words: 1, characters: 3 };
  verifyFixture(content, expected);

  // Guard that the fixture actually distinguishes the three notions of length.
  assert.equal(content.length, 4, 'UTF-16 code units');
  assert.equal(Buffer.byteLength(content, 'utf8'), 7, 'UTF-8 bytes');
  assert.equal([...content].length, 3, 'code points');

  const result = await runCli(['stats', makeFixture('ac3', content)]);
  assertStats(result, expected);
});

// --- AC4 : whitespace counted in characters -------------------------------
test('AC4: spaces, tabs and line endings are included in characters', async () => {
  const content = 'a b\t\nc';
  const expected = { lines: 2, words: 3, characters: 6 };
  verifyFixture(content, expected);

  const result = await runCli(['stats', makeFixture('ac4', content)]);
  assertStats(result, expected);
});

// --- AC5 : maximal non-whitespace word runs -------------------------------
test('AC5: consecutive spaces/tabs/newlines collapse into single words with no empty words', async () => {
  const content = '  foo\t\tbar\n\nbaz   qux  ';
  const expected = { lines: 3, words: 4, characters: 23 };
  verifyFixture(content, expected);

  const result = await runCli(['stats', makeFixture('ac5', content)]);
  assertStats(result, expected);
});

// --- AC7 : final LF does not add a line -----------------------------------
test('AC7: a final LF terminates the last record without adding an extra line', async () => {
  const noTrailing = 'a\nb';
  const expNoTrailing = { lines: 2, words: 2, characters: 3 };
  verifyFixture(noTrailing, expNoTrailing);
  assertStats(await runCli(['stats', makeFixture('ac7a', noTrailing)]), expNoTrailing);

  const withTrailing = 'a\nb\n';
  const expWithTrailing = { lines: 2, words: 2, characters: 4 };
  verifyFixture(withTrailing, expWithTrailing);
  assertStats(await runCli(['stats', makeFixture('ac7b', withTrailing)]), expWithTrailing);
});

// --- AC8 : CRLF separates lines; CR and LF each count as characters --------
test('AC8: CRLF separates lines and both CR and LF count as characters', async () => {
  const content = 'a\r\nb';
  // AC8 text says "5 characters", but 'a','\r','\n','b' is 4 code points.
  // We assert the accurate count; verifyFixture proves both independent checks
  // (hand-derived expected and code-point reference) agree on 4.
  const expected = { lines: 2, words: 2, characters: 4 };
  verifyFixture(content, expected);
  assert.equal([...content].length, 4);

  assertStats(await runCli(['stats', makeFixture('ac8', content)]), expected);
});

// --- AC9 : blank lines count as lines -------------------------------------
test('AC9: input of only blank lines reports the corresponding line count', async () => {
  const content = '\n\n';
  const expected = { lines: 2, words: 0, characters: 2 };
  verifyFixture(content, expected);

  assertStats(await runCli(['stats', makeFixture('ac9', content)]), expected);
});

// --- boundary: lone CR (does not break a line, still a character) ---------
test('boundary: a lone CR does not start a new line but counts as a character', async () => {
  const content = 'a\rb';
  const expected = { lines: 1, words: 2, characters: 3 };
  verifyFixture(content, expected);

  assertStats(await runCli(['stats', makeFixture('lonecr', content)]), expected);
});

// --- boundary: multiple trailing LFs each terminate a record --------------
test('boundary: trailing LFs each terminate a record', async () => {
  const content = 'a\n\n\n';
  const expected = { lines: 3, words: 1, characters: 4 };
  verifyFixture(content, expected);

  assertStats(await runCli(['stats', makeFixture('trail', content)]), expected);
});

// --- AC10 : nonexistent path ----------------------------------------------
test('AC10: nonexistent path -> nonzero exit, stderr message, empty stdout', async () => {
  const missing = path.join(baseDir, 'no-such-file-' + Date.now() + '.txt');
  assert.ok(!fs.existsSync(missing));

  assertCliError(await runCli(['stats', missing]));
});

// --- AC11 : directory path -------------------------------------------------
test('AC11: directory path -> nonzero exit, stderr message, empty stdout', async () => {
  const dir = fs.mkdtempSync(path.join(baseDir, 'dir-'));
  assert.ok(fs.statSync(dir).isDirectory());

  assertCliError(await runCli(['stats', dir]));
});

// --- AC12 : unrecognized command ------------------------------------------
test('AC12: unrecognized command -> nonzero exit, stderr message, empty stdout', async () => {
  const file = makeFixture('ac12', 'hello world');

  assertCliError(await runCli(['foo', file]));
  assertCliError(await runCli(['help', file]));
});

// --- AC13 : argument arity errors -----------------------------------------
test('AC13: wrong arity (no path, too many, no args, empty path) each fail', async () => {
  const file = makeFixture('ac13', 'x');

  assertCliError(await runCli(['stats'])); // missing path
  assertCliError(await runCli(['stats', file, file])); // too many paths
  assertCliError(await runCli([])); // no args at all
  assertCliError(await runCli(['stats', ''])); // invalid empty path
});

// --- AC14 : paths containing spaces ---------------------------------------
test('AC14: a path containing spaces is processed correctly', async () => {
  const spacedDir = path.join(baseDir, 'dir with spaces');
  fs.mkdirSync(spacedDir, { recursive: true });
  const spacedFile = path.join(spacedDir, 'my input file.txt');
  const content = 'hello world';
  fs.writeFileSync(spacedFile, content, 'utf8');

  const expected = { lines: 1, words: 2, characters: 11 };
  verifyFixture(content, expected);

  assertStats(await runCli(['stats', spacedFile]), expected);
});

// --- AC15 : TS build, built-ins only, no runtime deps, no network, no writes
test('AC15: built output uses Node built-ins only (no networking), has no runtime deps, and writes no files', async () => {
  // dist entry exists (produced by the TypeScript build)
  assert.ok(fs.existsSync(distEntry), 'dist/index.js must exist after the TypeScript build');

  // The entry point is produced from TypeScript sources.
  const srcEntry = path.join(projectRoot, 'src', 'index.ts');
  assert.ok(fs.existsSync(srcEntry), 'src/index.ts (TypeScript source) must exist');

  // no third-party runtime dependencies
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const runtimeDeps = pkg.dependencies ? Object.keys(pkg.dependencies) : [];
  assert.deepEqual(runtimeDeps, [], 'package.json must declare no runtime dependencies');

  // every import in compiled output is a Node builtin or a relative module,
  // and NO networking builtins (http/https/net/tls/dns/dgram/http2/...) appear.
  const distDir = path.dirname(distEntry);
  const jsFiles = fs.readdirSync(distDir).filter((n) => n.endsWith('.js'));
  assert.ok(jsFiles.length > 0, 'compiled output must contain JavaScript files');
  for (const name of jsFiles) {
    const src = fs.readFileSync(path.join(distDir, name), 'utf8');
    for (const spec of extractImportSpecifiers(src)) {
      assert.ok(
        spec.startsWith('.') || isBuiltinSpecifier(spec),
        `dist/${name} imports non-builtin module "${spec}"`,
      );
      assert.ok(
        spec.startsWith('.') || !isForbiddenNetworkSpecifier(spec),
        `dist/${name} imports forbidden networking module "${spec}"`,
      );
    }
    assert.ok(
      !GLOBAL_FETCH_RE.test(src),
      `dist/${name} references a global fetch(...) call (networking is forbidden)`,
    );
  }

  // running the CLI performs no writes: the input file and the working
  // directory must be byte-for-byte identical before and after the run.
  const workDir = fs.mkdtempSync(path.join(baseDir, 'nowrite-'));
  const workFile = path.join(workDir, 'input.txt');
  const content = 'hello world';
  fs.writeFileSync(workFile, content, 'utf8');

  const fileBytesBefore = fs.readFileSync(workFile);
  const statBefore = fs.statSync(workFile);
  const dirBefore = snapshotDir(workDir);

  const expected = { lines: 1, words: 2, characters: 11 };
  verifyFixture(content, expected);
  assertStats(await runCli(['stats', workFile], { cwd: workDir }), expected);

  const fileBytesAfter = fs.readFileSync(workFile);
  const statAfter = fs.statSync(workFile);
  const dirAfter = snapshotDir(workDir);

  assert.deepEqual(fileBytesAfter, fileBytesBefore, 'CLI must not modify the input file contents');
  assert.equal(statAfter.size, statBefore.size, 'CLI must not change the input file size');
  assert.equal(
    statAfter.mtimeMs,
    statBefore.mtimeMs,
    'CLI must not rewrite the input file (mtime must be unchanged)',
  );
  assert.deepEqual(dirAfter, dirBefore, 'CLI must not create or modify files in the working directory');
});
