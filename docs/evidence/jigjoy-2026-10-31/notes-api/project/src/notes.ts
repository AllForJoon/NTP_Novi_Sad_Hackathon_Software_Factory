import { randomUUID } from "node:crypto";

export interface Note {
  readonly id: string;
  readonly text: string;
}

export interface NoteStore {
  add(text: string): Note;
  list(): Note[];
  get(id: string): Note | undefined;
  delete(id: string): boolean;
}

/**
 * Normalize a candidate note text value.
 *
 * Returns the trimmed string only when `value` is a string whose trimmed
 * value is nonempty. Otherwise returns `undefined`.
 */
export function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

export function createNoteStore(): NoteStore {
  // Map preserves insertion order for iteration.
  const notes = new Map<string, Note>();

  return {
    add(text: string): Note {
      const trimmed = normalizeText(text);
      if (trimmed === undefined) {
        throw new TypeError("Note text must be a nonempty string");
      }
      const note: Note = { id: randomUUID(), text: trimmed };
      notes.set(note.id, note);
      return note;
    },
    list(): Note[] {
      return Array.from(notes.values());
    },
    get(id: string): Note | undefined {
      return notes.get(id);
    },
    delete(id: string): boolean {
      return notes.delete(id);
    },
  };
}
