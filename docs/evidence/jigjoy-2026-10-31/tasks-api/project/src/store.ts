import { randomUUID } from 'node:crypto';

export interface Task {
  id: string;
  title: string;
  completed: boolean;
}

export interface TaskInput {
  title: string;
  completed: boolean;
}

export interface TaskStore {
  create(input: TaskInput): Task;
  list(): Task[];
  get(id: string): Task | undefined;
  delete(id: string): boolean;
}

function copyTask(task: Task): Task {
  return { id: task.id, title: task.title, completed: task.completed };
}

/**
 * Creates an isolated in-memory task store.
 *
 * Each instance owns a private array of tasks, so independent stores never
 * share state. Tasks are kept in insertion order, IDs are nonempty unique
 * strings, and reads return shallow copies to prevent callers from mutating
 * stored state.
 */
export function createTaskStore(): TaskStore {
  const tasks: Task[] = [];

  function generateUniqueId(): string {
    let id = randomUUID();
    while (tasks.some((task) => task.id === id)) {
      id = randomUUID();
    }
    return id;
  }

  return {
    create(input: TaskInput): Task {
      const task: Task = {
        id: generateUniqueId(),
        title: input.title,
        completed: input.completed,
      };
      tasks.push(task);
      return copyTask(task);
    },

    list(): Task[] {
      return tasks.map(copyTask);
    },

    get(id: string): Task | undefined {
      const found = tasks.find((task) => task.id === id);
      return found === undefined ? undefined : copyTask(found);
    },

    delete(id: string): boolean {
      const index = tasks.findIndex((task) => task.id === id);
      if (index === -1) {
        return false;
      }
      tasks.splice(index, 1);
      return true;
    },
  };
}
