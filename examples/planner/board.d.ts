export type Task = {
  id: string;
  title: string;
  stage: string;
  owner: string;
  due: string;
  source?: string;
};
export const stages: string[];
export function renderBoard(
  host: HTMLElement,
  tasks: Task[],
  onMove: (id: string, stage: string) => void,
): void;
