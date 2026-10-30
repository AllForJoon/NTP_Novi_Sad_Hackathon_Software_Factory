import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createNoteStore } from "./notes.js";
import { createRequestHandler } from "./routes.js";

export function createServer(): Server {
  const store = createNoteStore();
  const handler = createRequestHandler(store);
  return createHttpServer(handler);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const rawPort = process.env.PORT;
  const port =
    rawPort !== undefined && rawPort !== "" ? Number(rawPort) : 3000;
  const server = createServer();
  server.listen(port);
}
