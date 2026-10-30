import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kinds = ['sum-cli', 'notes-api', 'file-counts', 'tasks-api'];

// Independent behavioral assertions: these do not use generated QA assertions
// or the Factory's contract/plan validators. The project must already be built.
export async function verifyOutput(kind, directory) {
  assert.ok(kinds.includes(kind), `Unknown task: ${kind}`);
  const root = resolve(directory);
  let checks = 0;
  const cli = args => {
    const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const result = spawnSync(process.execPath, ['dist/index.js', ...args], { cwd: root, env, encoding: 'utf8', timeout: 5000, shell: false, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
  const success = (args, expected, json = false) => {
    const result = cli(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.endsWith('\n'));
    if (json) assert.deepEqual(JSON.parse(result.stdout), expected);
    else assert.equal(result.stdout, expected);
    checks++;
  };
  const reject = args => {
    const result = cli(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.trim());
    checks++;
  };

  if (kind === 'sum-cli') {
    for (const [a, b, expected] of [['2', '3', '5\n'], ['-2', '3', '1\n'], ['1.5', '2.25', '3.75\n'], ['0', '0', '0\n']]) success(['sum', a, b], expected);
    for (const args of [[], ['other', '1', '2'], ['sum'], ['sum', '1'], ['sum', '1', '2', '3'], ...['', ' ', 'NaN', 'Infinity', '1e309', 'abc'].map(value => ['sum', value, '2'])]) reject(args);
  } else if (kind === 'file-counts') {
    mkdirSync(resolve(repository, '.work'), { recursive: true });
    const fixtures = mkdtempSync(resolve(repository, '.work', 'acceptance-'));
    const cases = [['', 0, 0, 0], ['hello world', 1, 2, 11], ['hi\n', 1, 1, 3], ['a\n\nb', 3, 2, 4], ['a\r\nb\r\n', 2, 2, 6], ['   ', 1, 0, 3], ['one\ttwo\nthree', 2, 3, 13], ['\u{1F600} caf\u00e9\n', 1, 2, 7], ['\n', 1, 0, 1]];
    for (const [text, lines, words, characters] of cases) {
      const file = join(fixtures, `sample ${checks}.txt`);
      writeFileSync(file, text);
      success(['stats', file], { lines, words, characters }, true);
    }
    for (const args of [[], ['nope', 'x'], ['stats'], ['stats', 'a', 'b'], ['stats', join(fixtures, 'missing')], ['stats', fixtures]]) reject(args);
  } else {
    const { createServer } = await import(pathToFileURL(resolve(root, 'dist/index.js')).href);
    const servers = [];
    const start = async () => {
      const server = createServer();
      servers.push(server);
      assert.equal(server.listening, false);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return `http://127.0.0.1:${server.address().port}`;
    };
    const request = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
    const errorObject = value => assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
    try {
      const base = await start();
      if (kind === 'notes-api') {
        let response = await request(base + '/notes');
        assert.equal(response.status, 200); assert.deepEqual(await response.json(), []); checks++;
        response = await request(base + '/notes', { method: 'POST', body: JSON.stringify({ text: '  first  ' }) });
        assert.equal(response.status, 201);
        const first = await response.json();
        assert.equal(first.text, 'first'); assert.equal(typeof first.id, 'string'); assert.ok(first.id); checks++;
        response = await request(base + '/notes', { method: 'POST', body: JSON.stringify({ text: 'second' }) });
        assert.equal(response.status, 201);
        const second = await response.json();
        assert.equal(second.text, 'second'); assert.notEqual(first.id, second.id); checks++;
        response = await request(base + '/notes'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), [first, second]); checks++;
        response = await request(base + '/notes/' + encodeURIComponent(first.id)); assert.equal(response.status, 200); assert.deepEqual(await response.json(), first); checks++;
        for (const body of ['{bad', '{}', '{"text":" "}', '{"text":null}', '{"text":9}']) {
          response = await request(base + '/notes', { method: 'POST', body }); assert.equal(response.status, 400); checks++;
        }
        for (const path of ['/unknown', '/notes/missing']) { response = await request(base + path); assert.equal(response.status, 404); checks++; }
        response = await request(base + '/notes/' + first.id, { method: 'DELETE' }); assert.equal(response.status, 204); assert.equal(await response.text(), ''); checks++;
        response = await request(base + '/notes/' + first.id, { method: 'DELETE' }); assert.equal(response.status, 404); checks++;
        response = await request(base + '/notes'); assert.deepEqual(await response.json(), [second]); checks++;
        response = await request(await start() + '/notes'); assert.deepEqual(await response.json(), []); checks++;
      } else {
        let response = await request(base + '/tasks'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), []); checks++;
        const tasks = [];
        for (const [body, expected] of [[{ title: '  one  ' }, { title: 'one', completed: false }], [{ title: 'two', completed: true }, { title: 'two', completed: true }], [{ title: 'three', completed: false }, { title: 'three', completed: false }]]) {
          response = await request(base + '/tasks', { method: 'POST', body: JSON.stringify(body) }); assert.equal(response.status, 201);
          const task = await response.json(); assert.equal(typeof task.id, 'string'); assert.ok(task.id); assert.deepEqual(task, { id: task.id, ...expected }); tasks.push(task); checks++;
        }
        assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length);
        response = await request(base + '/tasks'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), tasks); checks++;
        response = await request(base + '/tasks/' + encodeURIComponent(tasks[0].id)); assert.equal(response.status, 200); assert.deepEqual(await response.json(), tasks[0]); checks++;
        for (const body of ['{bad', 'null', '[]', '{}', '{"title":" "}', '{"title":4}', '{"title":"x","completed":"false"}', '{"title":"x","completed":null}', '{"title":"x","completed":0}']) {
          response = await request(base + '/tasks', { method: 'POST', body }); assert.equal(response.status, 400, body); errorObject(await response.json()); checks++;
        }
        response = await request(base + '/tasks/' + tasks[0].id, { method: 'DELETE' }); assert.equal(response.status, 204); assert.equal(await response.text(), ''); checks++;
        for (const [path, method] of [['/tasks/' + tasks[0].id, 'GET'], ['/tasks/' + tasks[0].id, 'DELETE'], ['/other', 'GET'], ['/tasks/unknown', 'GET']]) {
          response = await request(base + path, { method }); assert.equal(response.status, 404); errorObject(await response.json()); checks++;
        }
        response = await request(base + '/tasks'); assert.deepEqual(await response.json(), tasks.slice(1)); checks++;
        response = await request(await start() + '/tasks'); assert.deepEqual(await response.json(), []); checks++;
      }
    } finally {
      await Promise.all(servers.map(server => new Promise(done => { server.closeAllConnections(); server.close(done); })));
    }
  }
  return { kind, passed: true, independentAcceptanceChecks: checks };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [kind, directory, ...extra] = process.argv.slice(2);
    assert.ok(kind && directory && !extra.length, 'Usage: npm run verify:output -- <sum-cli|notes-api|file-counts|tasks-api> <built-project-directory>');
    console.log(JSON.stringify(await verifyOutput(kind, directory), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
