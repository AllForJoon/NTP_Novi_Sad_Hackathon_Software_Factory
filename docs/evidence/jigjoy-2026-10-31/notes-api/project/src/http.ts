import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Read the request body and parse it as JSON.
 *
 * Rejects with a SyntaxError when the body is not valid JSON (including an
 * empty body).
 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(
          error instanceof SyntaxError
            ? error
            : new SyntaxError("Malformed JSON body"),
        );
      }
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
}

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(payload);
}

export function sendEmpty(res: ServerResponse, statusCode: number): void {
  res.statusCode = statusCode;
  res.end();
}
