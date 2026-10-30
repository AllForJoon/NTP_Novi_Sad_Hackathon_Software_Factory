# In-memory Notes HTTP API

Create a TypeScript HTTP API using Node.js built-in modules only.
Export `createServer()` from `src/index.ts`, returning an unstarted Node HTTP server.
When executed directly, listen on PORT (default 3000).

- POST /notes accepts JSON {"text":"..."}, requires a nonempty trimmed string,
  and returns status 201 and {"id":"...","text":"..."}.
- GET /notes returns status 200 and a JSON array of all notes in insertion order.
- GET /notes/:id returns the note or status 404 for a missing note.
- DELETE /notes/:id returns status 204, or 404 for an unknown id.
- Reject malformed JSON with status 400. Reject missing, empty, or non-string text
  with status 400. Unknown routes return 404.

Store notes in memory per server instance. No authentication, database, frontend,
or external services. Tests should use port 0 and close their servers.
