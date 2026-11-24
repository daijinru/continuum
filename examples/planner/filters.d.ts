import type { Task } from "./board.js";
export function filterTasks(
  tasks: Task[],
  filters?: { query?: string; stage?: string; owner?: string },
): Task[];
