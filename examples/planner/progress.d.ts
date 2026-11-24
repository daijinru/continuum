import type { Task } from "./board.js";
export function summarize(
  tasks: Task[],
  today: string,
): {
  total: number;
  done: number;
  active: number;
  overdue: number;
  percent: number;
};
