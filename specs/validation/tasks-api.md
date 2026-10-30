# In-memory task collection HTTP API

Use TypeScript and Node built-in modules only. Export createServer() from
src/index.ts, returning an unstarted Node HTTP server with isolated in-memory
storage per instance. Executing dist/index.js directly listens on PORT (3000
default). Tests use ephemeral port 0 and close all servers.

- POST /tasks takes JSON {"title":"...","completed":false}. Title must be a
  nonempty string after trimming. completed is optional (defaults to false), and
  when supplied must be boolean. Return 201 and {"id":string,"title":trimmedString,
  "completed":boolean}. IDs are nonempty, unique strings.
- GET /tasks returns 200 and all tasks in insertion order as a JSON array.
- GET /tasks/:id returns 200 with that task or 404 for an unknown ID.
- DELETE /tasks/:id returns 204 with an empty body, or 404 for unknown IDs.
- Malformed JSON, null/array bodies, invalid titles and invalid completed values
  return 400. Unknown routes return 404. Error bodies are JSON objects.

No database, external packages, authentication, frontend or external services.
