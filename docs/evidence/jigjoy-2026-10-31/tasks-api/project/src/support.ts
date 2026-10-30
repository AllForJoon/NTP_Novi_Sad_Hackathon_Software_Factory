export interface NormalizedTaskInput {
  title: string;
  completed: boolean;
}

export type ParseTaskInputResult =
  | { ok: true; value: NormalizedTaskInput }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTaskInput(value: unknown): ParseTaskInputResult {
  if (!isPlainObject(value)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const rawTitle = value.title;
  if (typeof rawTitle !== "string") {
    return { ok: false, error: "title must be a string." };
  }

  const title = rawTitle.trim();
  if (title.length === 0) {
    return { ok: false, error: "title must be a nonempty string." };
  }

  let completed = false;
  if (Object.prototype.hasOwnProperty.call(value, "completed") && value.completed !== undefined) {
    if (typeof value.completed !== "boolean") {
      return { ok: false, error: "completed must be a boolean." };
    }
    completed = value.completed;
  }

  return { ok: true, value: { title, completed } };
}

export function errorBody(message: string): { error: string } {
  return { error: message };
}
