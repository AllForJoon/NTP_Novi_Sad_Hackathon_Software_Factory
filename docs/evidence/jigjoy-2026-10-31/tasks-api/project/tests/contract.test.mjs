import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../dist/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(HERE);
const DIST_ENTRY = path.join(PROJECT_ROOT, 'dist', 'index.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function postTask(port, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return request(port, {
    method: 'POST',
    path: '/tasks',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
}

function listen(server, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server listen timed out')), timeoutMs);
    server.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timer);
      resolve(server.address().port);
    });
  });
}

async function stopServer(server) {
  if (!server || !server.listening) return;
  await Promise.race([
    new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }),
    delay(5000),
  ]);
}

async function withFreshServer(fn) {
  const server = createServer();
  assert.equal(server.listening, false, 'createServer() must return an unstarted server');
  const port = await listen(server);
  try {
    return await fn({ server, port });
  } finally {
    await stopServer(server);
    assert.equal(server.listening, false, 'server must be closed after test');
  }
}

function pickTask(value) {
  return { id: value.id, title: value.title, completed: value.completed };
}

function parseErrorBody(bodyText) {
  assert.equal(typeof bodyText, 'string', 'error response body must be a string');
  assert.notEqual(bodyText.trim(), '', 'error response body must not be empty');
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    assert.fail(`error response body must be valid JSON, received: ${bodyText}`);
  }
  assert.ok(
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    'error body must be a JSON object',
  );
  return parsed;
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must be nonempty`);
}

async function getFreePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function spawnChild(portEnv) {
  const env = { ...process.env };
  if (portEnv === undefined) delete env.PORT;
  else env.PORT = String(portEnv);
  const child = spawn(process.execPath, [DIST_ENTRY], {
    cwd: PROJECT_ROOT,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderrBuffer = '';
  child.stdoutBuffer = '';
  child.stderr.on('data', (d) => {
    child.stderrBuffer += d.toString();
  });
  child.stdout.on('data', (d) => {
    child.stdoutBuffer += d.toString();
  });
  return child;
}

async function waitForReady(child, port, timeoutMs = 15000) {
  const poll = (async () => {
    const start = Date.now();
    let lastError;
    while (Date.now() - start < timeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `server process exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode}); stderr=${child.stderrBuffer}`,
        );
      }
      try {
        const res = await request(port, { path: '/tasks' });
        if (res.status === 200) return res;
        lastError = new Error(`unexpected status ${res.status} from readiness probe`);
      } catch (err) {
        lastError = err;
      }
      await delay(100);
    }
    throw new Error(`server did not become ready on port ${port}: ${lastError && lastError.message}`);
  })();
  const exited = new Promise((_, reject) => {
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `server process exited before becoming ready (code=${code}, signal=${signal}); stderr=${child.stderrBuffer}`,
        ),
      );
    });
  });
  return Promise.race([poll, exited]);
}

async function stopChild(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const killer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 4000);
  await exited;
  clearTimeout(killer);
}

// ---------------------------------------------------------------------------
// REQ-1 / AC-1: createServer factory, unstarted, isolated storage
// ---------------------------------------------------------------------------

test('AC-1 createServer() returns an unstarted node http server', async () => {
  const server = createServer();
  assert.ok(server instanceof http.Server, 'createServer() must return a node:http Server');
  assert.equal(typeof server.listen, 'function', 'server must expose listen()');
  assert.equal(server.listening, false, 'returned server must not be listening');
  await stopServer(server);
});

test('AC-1 two instances have fully isolated in-memory storage', async () => {
  const first = createServer();
  const second = createServer();
  assert.ok(first instanceof http.Server);
  assert.ok(second instanceof http.Server);
  assert.equal(first.listening, false);
  assert.equal(second.listening, false);

  const portOne = await listen(first);
  const portTwo = await listen(second);
  try {
    const created = await postTask(portOne, { title: 'only in instance one' });
    assert.equal(created.status, 201, 'creating a task on the first instance must succeed');

    const secondList = await request(portTwo, { path: '/tasks' });
    assert.equal(secondList.status, 200);
    assert.deepStrictEqual(JSON.parse(secondList.body), [], 'second instance must not see first instance tasks');

    const firstList = await request(portOne, { path: '/tasks' });
    assert.equal(firstList.status, 200);
    const firstArr = JSON.parse(firstList.body);
    assert.ok(Array.isArray(firstArr));
    assert.equal(firstArr.length, 1, 'first instance must retain its own task');
  } finally {
    await stopServer(first);
    await stopServer(second);
    assert.equal(first.listening, false, 'first server must close successfully');
    assert.equal(second.listening, false, 'second server must close successfully');
  }
});

// ---------------------------------------------------------------------------
// REQ-5 / AC-7 support: fresh server returns empty array
// ---------------------------------------------------------------------------

test('AC-5 GET /tasks on a fresh instance returns 200 and an empty JSON array', async () => {
  await withFreshServer(async ({ port }) => {
    const res = await request(port, { path: '/tasks' });
    assert.equal(res.status, 200);
    const arr = JSON.parse(res.body);
    assert.ok(Array.isArray(arr), 'GET /tasks must return a JSON array');
    assert.deepStrictEqual(arr, []);
  });
});

// ---------------------------------------------------------------------------
// REQ-3 / AC-3: normalization of title and explicit completed:false
// ---------------------------------------------------------------------------

test('AC-3 POST /tasks trims title and honors completed=false end to end', async () => {
  await withFreshServer(async ({ port }) => {
    const res = await postTask(port, { title: '  Buy milk  ', completed: false });
    assert.equal(res.status, 201);
    const json = JSON.parse(res.body);
    assertNonEmptyString(json.id, 'id');
    assert.equal(typeof json.completed, 'boolean', 'completed must be a boolean');
    assert.deepStrictEqual(pickTask(json), { id: json.id, title: 'Buy milk', completed: false });

    const got = await request(port, { path: `/tasks/${encodeURIComponent(json.id)}` });
    assert.equal(got.status, 200);
    const gjson = JSON.parse(got.body);
    assert.equal(typeof gjson.completed, 'boolean');
    assert.deepStrictEqual(pickTask(gjson), { id: json.id, title: 'Buy milk', completed: false });
  });
});

// ---------------------------------------------------------------------------
// REQ-3 / AC-4: completed defaults to false and title is trimmed
// ---------------------------------------------------------------------------

test('AC-4 POST /tasks defaults completed to false and trims title', async () => {
  await withFreshServer(async ({ port }) => {
    const res = await postTask(port, { title: '  Default task  ' });
    assert.equal(res.status, 201);
    const json = JSON.parse(res.body);
    assertNonEmptyString(json.id, 'id');
    assert.equal(typeof json.completed, 'boolean', 'defaulted completed must be a boolean');
    assert.deepStrictEqual(pickTask(json), { id: json.id, title: 'Default task', completed: false });

    const got = await request(port, { path: `/tasks/${encodeURIComponent(json.id)}` });
    assert.equal(got.status, 200);
    const gjson = JSON.parse(got.body);
    assert.deepStrictEqual(pickTask(gjson), { id: json.id, title: 'Default task', completed: false });
  });
});

// ---------------------------------------------------------------------------
// REQ-3 / AC-5: explicit completed:true preserved and title trimmed
// ---------------------------------------------------------------------------

test('AC-5 POST /tasks preserves completed=true and trims title', async () => {
  await withFreshServer(async ({ port }) => {
    const res = await postTask(port, { title: '  Complete task  ', completed: true });
    assert.equal(res.status, 201);
    const json = JSON.parse(res.body);
    assertNonEmptyString(json.id, 'id');
    assert.equal(typeof json.completed, 'boolean');
    assert.deepStrictEqual(pickTask(json), { id: json.id, title: 'Complete task', completed: true });

    const got = await request(port, { path: `/tasks/${encodeURIComponent(json.id)}` });
    assert.equal(got.status, 200);
    const gjson = JSON.parse(got.body);
    assert.deepStrictEqual(pickTask(gjson), { id: json.id, title: 'Complete task', completed: true });
  });
});

// ---------------------------------------------------------------------------
// REQ-3 noncanonical whitespace: only surrounding whitespace is trimmed
// ---------------------------------------------------------------------------

test('REQ-3 trims surrounding unicode/tab whitespace but preserves interior spaces', async () => {
  await withFreshServer(async ({ port }) => {
    const res = await postTask(port, { title: ' \u00a0\tNoncanonical Task\n ', completed: false });
    assert.equal(res.status, 201);
    const json = JSON.parse(res.body);
    assert.deepStrictEqual(pickTask(json), { id: json.id, title: 'Noncanonical Task', completed: false });

    const interior = await postTask(port, { title: '  two  words  ' });
    assert.equal(interior.status, 201);
    const ijson = JSON.parse(interior.body);
    assert.deepStrictEqual(pickTask(ijson), { id: ijson.id, title: 'two  words', completed: false });
  });
});

// ---------------------------------------------------------------------------
// REQ-4 / AC-6: unique nonempty ids
// ---------------------------------------------------------------------------

test('AC-6 three created tasks have nonempty pairwise-distinct ids', async () => {
  await withFreshServer(async ({ port }) => {
    const ids = [];
    for (const title of ['  First  ', 'Second', '  Third  ']) {
      const res = await postTask(port, { title });
      assert.equal(res.status, 201);
      const json = JSON.parse(res.body);
      assertNonEmptyString(json.id, 'id');
      ids.push(json.id);
    }
    assert.equal(new Set(ids).size, 3, 'task ids must be pairwise distinct');
  });
});

// ---------------------------------------------------------------------------
// REQ-5 / AC-7: insertion order
// ---------------------------------------------------------------------------

test('AC-7 GET /tasks returns tasks in insertion order', async () => {
  await withFreshServer(async ({ port }) => {
    for (const title of ['  First  ', 'Second', '  Third  ']) {
      const res = await postTask(port, { title });
      assert.equal(res.status, 201);
    }
    const list = await request(port, { path: '/tasks' });
    assert.equal(list.status, 200);
    const arr = JSON.parse(list.body);
    assert.ok(Array.isArray(arr), 'GET /tasks must return a JSON array');
    assert.equal(arr.length, 3);
    assert.deepStrictEqual(
      arr.map((t) => t.title),
      ['First', 'Second', 'Third'],
    );
  });
});

// ---------------------------------------------------------------------------
// REQ-6 / AC-8: GET /tasks/:id returns the matching task
// ---------------------------------------------------------------------------

test('AC-8 GET /tasks/:id returns the created task including normalized values', async () => {
  await withFreshServer(async ({ port }) => {
    const res = await postTask(port, { title: '  Detail  ', completed: true });
    assert.equal(res.status, 201);
    const json = JSON.parse(res.body);
    assertNonEmptyString(json.id, 'id');

    const got = await request(port, { path: `/tasks/${encodeURIComponent(json.id)}` });
    assert.equal(got.status, 200);
    const gjson = JSON.parse(got.body);
    assert.deepStrictEqual(pickTask(gjson), { id: json.id, title: 'Detail', completed: true });
  });
});

// ---------------------------------------------------------------------------
// REQ-6 / AC-9: unknown id -> 404 JSON object
// ---------------------------------------------------------------------------

test('AC-9 GET /tasks/does-not-exist returns 404 with a JSON object error body', async () => {
  await withFreshServer(async ({ port }) => {
    const res = await request(port, { path: '/tasks/does-not-exist' });
    assert.equal(res.status, 404);
    parseErrorBody(res.body);
  });
});

// ---------------------------------------------------------------------------
// REQ-7 / AC-10: DELETE existing -> 204 empty body, removes the task
// ---------------------------------------------------------------------------

test('AC-10 DELETE existing task returns 204 empty body and removes it', async () => {
  await withFreshServer(async ({ port }) => {
    const created = await postTask(port, { title: '  Temporary  ' });
    assert.equal(created.status, 201);
    const json = JSON.parse(created.body);
    const id = json.id;
    assertNonEmptyString(id, 'id');

    const del = await request(port, { method: 'DELETE', path: `/tasks/${encodeURIComponent(id)}` });
    assert.equal(del.status, 204);
    assert.equal(del.body, '', '204 response must have an empty body');

    const got = await request(port, { path: `/tasks/${encodeURIComponent(id)}` });
    assert.equal(got.status, 404);
    parseErrorBody(got.body);

    const list = await request(port, { path: '/tasks' });
    assert.equal(list.status, 200);
    const arr = JSON.parse(list.body);
    assert.ok(Array.isArray(arr));
    assert.equal(
      arr.some((t) => t.id === id),
      false,
      'deleted task must no longer appear in GET /tasks',
    );

    const delAgain = await request(port, { method: 'DELETE', path: `/tasks/${encodeURIComponent(id)}` });
    assert.equal(delAgain.status, 404, 'deleting an already-deleted task must return 404');
    parseErrorBody(delAgain.body);
  });
});

// ---------------------------------------------------------------------------
// REQ-7 / AC-11: DELETE unknown -> 404 JSON object
// ---------------------------------------------------------------------------

test('AC-11 DELETE /tasks/does-not-exist returns 404 with a JSON object error body', async () => {
  await withFreshServer(async ({ port }) => {
    const res = await request(port, { method: 'DELETE', path: '/tasks/does-not-exist' });
    assert.equal(res.status, 404);
    parseErrorBody(res.body);
  });
});

// ---------------------------------------------------------------------------
// REQ-8 / AC-12: malformed JSON -> 400 JSON object, no state mutation
// ---------------------------------------------------------------------------

test('AC-12 POST /tasks with malformed JSON returns 400 JSON object and does not mutate state', async () => {
  await withFreshServer(async ({ port }) => {
    for (const bad of ['{"title":', 'this is not json', '{"title":"x",}']) {
      const res = await postTask(port, bad);
      assert.equal(res.status, 400, `malformed body ${JSON.stringify(bad)} must yield 400`);
      parseErrorBody(res.body);
    }
    const list = await request(port, { path: '/tasks' });
    assert.equal(list.status, 200);
    assert.deepStrictEqual(JSON.parse(list.body), [], 'malformed requests must not create tasks');
  });
});

// ---------------------------------------------------------------------------
// REQ-8 / AC-13: null and array bodies -> 400 JSON object
// ---------------------------------------------------------------------------

test('AC-13 POST /tasks with null or array body returns 400 JSON object', async () => {
  await withFreshServer(async ({ port }) => {
    for (const bad of ['null', '[]', '[{"title":"array task"}]', 'true', '42', '"a string"']) {
      const res = await postTask(port, bad);
      assert.equal(res.status, 400, `body ${bad} must yield 400`);
      parseErrorBody(res.body);
    }
    const list = await request(port, { path: '/tasks' });
    assert.deepStrictEqual(JSON.parse(list.body), [], 'rejected bodies must not create tasks');
  });
});

// ---------------------------------------------------------------------------
// REQ-8 / AC-14: invalid titles -> 400 JSON object
// ---------------------------------------------------------------------------

test('AC-14 POST /tasks with missing/empty/whitespace/non-string title returns 400 JSON object', async () => {
  await withFreshServer(async ({ port }) => {
    const bodies = [
      {},
      { completed: true },
      { title: '' },
      { title: '   ' },
      { title: '\t\n ' },
      { title: 123 },
      { title: null },
      { title: true },
      { title: ['array'] },
      { title: { nested: 'x' } },
    ];
    for (const body of bodies) {
      const res = await postTask(port, body);
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} must yield 400`);
      parseErrorBody(res.body);
    }
    const list = await request(port, { path: '/tasks' });
    assert.deepStrictEqual(JSON.parse(list.body), [], 'rejected titles must not create tasks');
  });
});

// ---------------------------------------------------------------------------
// REQ-8 / AC-15: invalid completed values -> 400 JSON object
// ---------------------------------------------------------------------------

test('AC-15 POST /tasks with non-boolean completed returns 400 JSON object', async () => {
  await withFreshServer(async ({ port }) => {
    const bodies = [
      { title: 'ok', completed: 'false' },
      { title: 'ok', completed: null },
      { title: 'ok', completed: 1 },
      { title: 'ok', completed: 0 },
      { title: 'ok', completed: 'true' },
    ];
    for (const body of bodies) {
      const res = await postTask(port, body);
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} must yield 400`);
      parseErrorBody(res.body);
    }
    const list = await request(port, { path: '/tasks' });
    assert.deepStrictEqual(JSON.parse(list.body), [], 'rejected completed values must not create tasks');
  });
});

// ---------------------------------------------------------------------------
// REQ-8 / AC-16: unknown route -> 404 JSON object
// ---------------------------------------------------------------------------

test('AC-16 GET /not-a-route returns 404 with a JSON object error body', async () => {
  await withFreshServer(async ({ port }) => {
    const res = await request(port, { path: '/not-a-route' });
    assert.equal(res.status, 404);
    parseErrorBody(res.body);
  });
});

// ---------------------------------------------------------------------------
// Robustness: extra body keys (including a raw "__proto__" own key) are ignored
// and do not pollute Object.prototype; normalization still applies.
// ---------------------------------------------------------------------------

test('REQ-3 extra body keys are ignored and __proto__ own key does not pollute', async () => {
  await withFreshServer(async ({ port }) => {
    const raw = '{"title":"  Keyed  ","completed":true,"__proto__":{"polluted":true},"extra":123}';
    // Guard: confirm the raw fixture really carries an own "__proto__" key.
    const parsedFixture = JSON.parse(raw);
    assert.equal(Object.hasOwn(parsedFixture, '__proto__'), true, 'fixture must carry an own __proto__ key');

    const res = await postTask(port, raw);
    assert.equal(res.status, 201);
    const json = JSON.parse(res.body);
    assert.deepStrictEqual(pickTask(json), { id: json.id, title: 'Keyed', completed: true });
    assert.equal(
      Object.prototype.polluted,
      undefined,
      'Object.prototype must not be polluted by a __proto__ key in the request body',
    );

    const got = await request(port, { path: `/tasks/${encodeURIComponent(json.id)}` });
    assert.equal(got.status, 200);
    const gjson = JSON.parse(got.body);
    assert.deepStrictEqual(pickTask(gjson), { id: json.id, title: 'Keyed', completed: true });
  });
});

// ---------------------------------------------------------------------------
// REQ-2 / AC-2: direct execution honors PORT and defaults to 3000
// ---------------------------------------------------------------------------

test('AC-2 executing dist/index.js listens on the supplied PORT', async () => {
  const freePort = await getFreePort();
  const child = spawnChild(freePort);
  try {
    const root = await waitForReady(child, freePort);
    assert.equal(root.status, 200);
    assert.deepStrictEqual(JSON.parse(root.body), []);

    const created = await postTask(freePort, { title: '  Via PORT  ' });
    assert.equal(created.status, 201);
    const json = JSON.parse(created.body);
    assert.deepStrictEqual(pickTask(json), { id: json.id, title: 'Via PORT', completed: false });
  } finally {
    await stopChild(child);
  }
});

test('AC-2 executing dist/index.js with no PORT serves on port 3000', async () => {
  const child = spawnChild(undefined);
  try {
    const root = await waitForReady(child, 3000);
    assert.equal(root.status, 200, 'default listener on port 3000 must answer GET /tasks');
    const arr = JSON.parse(root.body);
    assert.ok(Array.isArray(arr), 'default listener must return a JSON array');
    assert.deepStrictEqual(arr, []);

    const created = await postTask(3000, { title: '  Default port  ', completed: true });
    assert.equal(created.status, 201);
    const json = JSON.parse(created.body);
    assert.deepStrictEqual(pickTask(json), { id: json.id, title: 'Default port', completed: true });
  } finally {
    await stopChild(child);
  }
});
