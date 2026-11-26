import { createContext, useContext, useState } from "react";

import type { Data } from "./lib.tsx";

export const messageKey = (m: Data): string =>
  m.approvalGoal ? "approval:" + m.approvalGoal : m.id;

export const ChatRowState = createContext<{
  values: Map<string, unknown>;
  id: string;
} | null>(null);

// Virtual rows unmount. Keep only fields the user actually changed, for the
// lifetime of this conversation view; nothing from an inline form goes to disk.
export function useRowState<T>(
  field: string,
  initial: T,
): [T, (next: T) => void] {
  const row = useContext(ChatRowState);
  const key = row?.id + ":" + field;
  const [value, setValue] = useState<T>(() =>
    row?.values.has(key) ? (row.values.get(key) as T) : initial,
  );
  return [
    value,
    (next) => {
      row?.values.set(key, next);
      setValue(next);
    },
  ];
}
