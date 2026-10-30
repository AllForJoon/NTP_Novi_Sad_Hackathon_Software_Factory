import type { IncomingMessage, ServerResponse } from "node:http";
import type { NoteStore } from "./notes.js";
import { normalizeText } from "./notes.js";
import { readJsonBody, sendEmpty, sendJson } from "./http.js";

function extractText(body: unknown): unknown {
  if (body !== null && typeof body === "object") {
    return (body as Record<string, unknown>).text;
  }
  return undefined;
}

export function createRequestHandler(
  store: NoteStore,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(req, res, store).catch(() => {
      if (!res.headersSent) {
        sendEmpty(res, 400);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: NoteStore,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/notes") {
    if (method === "GET") {
      sendJson(res, 200, store.list());
      return;
    }
    if (method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendEmpty(res, 400);
        return;
      }
      const text = normalizeText(extractText(body));
      if (text === undefined) {
        sendEmpty(res, 400);
        return;
      }
      const note = store.add(text);
      sendJson(res, 201, note);
      return;
    }
    sendEmpty(res, 404);
    return;
  }

  if (pathname.startsWith("/notes/")) {
    const id = pathname.slice("/notes/".length);
    if (method === "GET") {
      const note = store.get(id);
      if (note === undefined) {
        sendEmpty(res, 404);
        return;
      }
      sendJson(res, 200, note);
      return;
    }
    if (method === "DELETE") {
      if (store.delete(id)) {
        sendEmpty(res, 204);
        return;
      }
      sendEmpty(res, 404);
      return;
    }
    sendEmpty(res, 404);
    return;
  }

  sendEmpty(res, 404);
}
