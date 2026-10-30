import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createTaskStore } from "./store.js";
import { parseTaskInput, errorBody } from "./support.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(payload);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer(): Server {
  const store = createTaskStore();

  async function handlePostTasks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 400, errorBody("Failed to read request body."));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, errorBody("Request body must be valid JSON."));
      return;
    }

    const result = parseTaskInput(parsed);
    if (!result.ok) {
      sendJson(res, 400, errorBody(result.error));
      return;
    }

    const task = store.create(result.value);
    sendJson(res, 201, task);
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter((part) => part.length > 0);
    const method = (req.method ?? "GET").toUpperCase();

    if (segments.length === 1 && segments[0] === "tasks") {
      if (method === "POST") {
        void handlePostTasks(req, res);
        return;
      }
      if (method === "GET") {
        sendJson(res, 200, store.list());
        return;
      }
      sendJson(res, 404, errorBody("Route not found."));
      return;
    }

    if (segments.length === 2 && segments[0] === "tasks") {
      let id: string;
      try {
        id = decodeURIComponent(segments[1]!);
      } catch {
        sendJson(res, 404, errorBody("Route not found."));
        return;
      }

      if (method === "GET") {
        const task = store.get(id);
        if (!task) {
          sendJson(res, 404, errorBody("Task not found."));
          return;
        }
        sendJson(res, 200, task);
        return;
      }

      if (method === "DELETE") {
        const removed = store.delete(id);
        if (!removed) {
          sendJson(res, 404, errorBody("Task not found."));
          return;
        }
        sendEmpty(res, 204);
        return;
      }

      sendJson(res, 404, errorBody("Route not found."));
      return;
    }

    sendJson(res, 404, errorBody("Route not found."));
  }

  return createHttpServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, errorBody("Internal server error."));
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
  createServer().listen(port);
}
