import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";

import { createServer } from "../dist/index.js";

const ROOT = process.cwd();
const ENTRY = path.resolve(ROOT, "dist", "index.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const headers = {};
    if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function startInProcessServer() {
  assert.equal(typeof createServer, "function", "createServer must be exported as a function");
  const server = createServer();
  assert.equal(server.listening, false, "createServer() must return an unstarted server");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return { server, port };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForHttp(port, timeoutMs = 15000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request(port, "GET", "/notes");
      if (res.statusCode === 200) return res;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`server on port ${port} did not become ready: ${lastError}`);
}

function waitExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function postText(port, text) {
  const res = await request(port, "POST", "/notes", { text });
  return res;
}

async function createNote(port, text) {
  const res = await postText(port, text);
  assert.equal(res.statusCode, 201, `expected 201 creating note from ${JSON.stringify(text)}`);
  const note = JSON.parse(res.body);
  assert.equal(typeof note.id, "string");
  assert.ok(note.id.length > 0, "note id must be a nonempty string");
  return note;
}

// --------------------------------------------------------------------------
// R1 / AC1
// --------------------------------------------------------------------------
test("R1/AC1: createServer returns an unstarted server with isolated per-instance stores", async () => {
  const first = await startInProcessServer();
  const second = await startInProcessServer();
  try {
    assert.notEqual(first.server, second.server, "each createServer() call must return a new server");

    const created = await createNote(first.port, "only-in-first");
    assert.equal(created.text, "only-in-first");

    const firstList = JSON.parse((await request(first.port, "GET", "/notes")).body);
    assert.equal(firstList.length, 1, "first server must list the posted note");
    assert.equal(firstList[0].text, "only-in-first");

    const secondList = JSON.parse((await request(second.port, "GET", "/notes")).body);
    assert.deepEqual(secondList, [], "second server must have its own empty store");
  } finally {
    await stopServer(first.server);
    await stopServer(second.server);
  }
});

// --------------------------------------------------------------------------
// R2 / AC2
// --------------------------------------------------------------------------
test("R2/AC2: direct execution defaults to port 3000 when PORT is unset", async (t) => {
  if (!(await isPortFree(3000))) {
    t.skip("port 3000 is not available in this environment");
    return;
  }
  const env = { ...process.env };
  delete env.PORT;
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env,
    shell: false,
    stdio: "ignore",
  });
  try {
    const res = await waitForHttp(3000);
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)), "GET /notes must return a JSON array");
  } finally {
    child.kill();
    await waitExit(child);
  }
});

test("R2/AC2: direct execution listens on the provided PORT", async () => {
  const port = await findFreePort();
  const env = { ...process.env, PORT: String(port) };
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env,
    shell: false,
    stdio: "ignore",
  });
  try {
    const res = await waitForHttp(port);
    assert.equal(res.statusCode, 200);

    const posted = await postText(port, "  from-spawned  ");
    assert.equal(posted.statusCode, 201);
    assert.equal(JSON.parse(posted.body).text, "from-spawned");
  } finally {
    child.kill();
    await waitExit(child);
  }
});

// --------------------------------------------------------------------------
// R3 / AC3  (noncanonical valid input -> exact normalized output)
// --------------------------------------------------------------------------
test("R3/R4/AC3: POST trims noncanonical valid text and stores/returns the exact normalized value", async () => {
  const { server, port } = await startInProcessServer();
  try {
    const res = await request(port, "POST", "/notes", { text: "  alpha  " });
    assert.equal(res.statusCode, 201);
    assert.match(String(res.headers["content-type"]), /application\/json/);
    const note = JSON.parse(res.body);
    assert.equal(typeof note.id, "string");
    assert.ok(note.id.length > 0);
    assert.equal(note.text, "alpha", "returned text must be exactly the trimmed value");

    const listRes = await request(port, "GET", "/notes");
    assert.equal(listRes.statusCode, 200);
    const list = JSON.parse(listRes.body);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, note.id);
    assert.equal(list[0].text, "alpha", "stored text must be exactly the trimmed value");

    const second = await postText(port, "\t\n  beta \t\n ");
    assert.equal(second.statusCode, 201);
    assert.equal(JSON.parse(second.body).text, "beta", "leaked whitespace codepoints must be trimmed");
  } finally {
    await stopServer(server);
  }
});

// --------------------------------------------------------------------------
// R3 / AC4  (malformed JSON)
// --------------------------------------------------------------------------
test("R3/AC4: malformed JSON returns 400 and stores nothing", async () => {
  const { server, port } = await startInProcessServer();
  try {
    const res = await request(port, "POST", "/notes", '{ "text": "broken" ');
    assert.equal(res.statusCode, 400);

    const list = JSON.parse((await request(port, "GET", "/notes")).body);
    assert.deepEqual(list, [], "a malformed request must not create a note");
  } finally {
    await stopServer(server);
  }
});

// --------------------------------------------------------------------------
// R3 / AC5  (missing/empty/whitespace-only/non-string text)
// --------------------------------------------------------------------------
test("R3/AC5: missing/empty/whitespace-only/non-string text returns 400", async () => {
  const { server, port } = await startInProcessServer();
  try {
    const invalidBodies = [
      {},
      { text: "" },
      { text: "   " },
      { text: "\t\n\r " },
      { text: 123 },
      { text: null },
      { text: true },
      { text: [] },
      { text: ["x"] },
      { text: { a: 1 } },
    ];
    for (const body of invalidBodies) {
      const res = await request(port, "POST", "/notes", body);
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
    }

    // Special own-key object value: JSON.parse keeps "__proto__" as an own data key.
    const rawObjectFixture = '{"text":{"__proto__":{"polluted":true},"safe":"x"}}';
    const parsedFixture = JSON.parse(rawObjectFixture);
    assert.ok(
      Object.hasOwn(parsedFixture.text, "__proto__"),
      "fixture must carry __proto__ as an own key, not the prototype",
    );
    const objectRes = await request(port, "POST", "/notes", rawObjectFixture);
    assert.equal(objectRes.statusCode, 400);

    assert.deepEqual(
      JSON.parse((await request(port, "GET", "/notes")).body),
      [],
      "no invalid request may create a note",
    );
    assert.equal({}.polluted, undefined, "server must not pollute Object.prototype");
  } finally {
    await stopServer(server);
  }
});

// --------------------------------------------------------------------------
// R4 / AC6  (empty list, then insertion order)
// --------------------------------------------------------------------------
test("R4/AC6: new server returns [] then notes in insertion order with normalized text", async () => {
  const { server, port } = await startInProcessServer();
  try {
    const emptyRes = await request(port, "GET", "/notes");
    assert.equal(emptyRes.statusCode, 200);
    assert.match(String(emptyRes.headers["content-type"]), /application\/json/);
    assert.deepEqual(JSON.parse(emptyRes.body), []);

    const a = await createNote(port, "  note A  ");
    const b = await createNote(port, "note B");

    const listRes = await request(port, "GET", "/notes");
    assert.equal(listRes.statusCode, 200);
    const list = JSON.parse(listRes.body);
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 2);
    assert.equal(list[0].id, a.id);
    assert.equal(list[0].text, "note A");
    assert.equal(list[1].id, b.id);
    assert.equal(list[1].text, "note B");
  } finally {
    await stopServer(server);
  }
});

// --------------------------------------------------------------------------
// R5 / AC7
// --------------------------------------------------------------------------
test("R5/AC7: GET /notes/:id returns the matching note and 404 for unknown ids", async () => {
  const { server, port } = await startInProcessServer();
  try {
    const created = await createNote(port, "  find me  ");
    assert.equal(created.text, "find me");

    const foundRes = await request(port, "GET", `/notes/${encodeURIComponent(created.id)}`);
    assert.equal(foundRes.statusCode, 200);
    assert.deepEqual(JSON.parse(foundRes.body), { id: created.id, text: "find me" });

    const missingRes = await request(port, "GET", "/notes/does-not-exist-" + Date.now());
    assert.equal(missingRes.statusCode, 404);
  } finally {
    await stopServer(server);
  }
});

// --------------------------------------------------------------------------
// R6 / AC8
// --------------------------------------------------------------------------
test("R6/AC8: DELETE existing returns 204 then GET 404; DELETE unknown returns 404", async () => {
  const { server, port } = await startInProcessServer();
  try {
    const created = await createNote(port, "delete-me");

    const delRes = await request(port, "DELETE", `/notes/${encodeURIComponent(created.id)}`);
    assert.equal(delRes.statusCode, 204);
    assert.equal(delRes.body, "");

    const afterRes = await request(port, "GET", `/notes/${encodeURIComponent(created.id)}`);
    assert.equal(afterRes.statusCode, 404);

    const list = JSON.parse((await request(port, "GET", "/notes")).body);
    assert.deepEqual(list, [], "deleted note must be gone from the collection");

    const unknownDel = await request(port, "DELETE", "/notes/unknown-" + Date.now());
    assert.equal(unknownDel.statusCode, 404);
  } finally {
    await stopServer(server);
  }
});

// --------------------------------------------------------------------------
// R7 / AC9
// --------------------------------------------------------------------------
test("R7/AC9: unknown routes return 404", async () => {
  const { server, port } = await startInProcessServer();
  try {
    const getRes = await request(port, "GET", "/unknown");
    assert.equal(getRes.statusCode, 404);

    const postRes = await request(port, "POST", "/unknown", { text: "x" });
    assert.equal(postRes.statusCode, 404);

    const rootRes = await request(port, "GET", "/");
    assert.equal(rootRes.statusCode, 404);
  } finally {
    await stopServer(server);
  }
});
