import { useSyncExternalStore } from "react";
import { api, type Data } from "./lib.tsx";
import { redact } from "../../../packages/agent-core/src/index.ts";

type Submission = {
  key: string;
  text: string;
  replyTo?: string;
  focus?: string;
};
type Entry = {
  submission: Submission;
  created: string;
  status: "queued" | "sending" | "failed" | "sent";
  error?: string;
  seq?: number;
};

const storageKey = "main-outbox";
// The desktop development window can be recreated while a draft is open.
export function conversationStorage(): Storage {
  return import.meta.env.MODE === "desktop-dev" ? localStorage : sessionStorage;
}
function restore(): Entry[] {
  try {
    const saved: Entry[] = JSON.parse(
      conversationStorage().getItem(storageKey) || "[]",
    );
    return saved
      .filter(
        (entry) =>
          typeof entry?.submission?.key === "string" &&
          typeof entry.submission.text === "string",
      )
      .map((entry) => ({
        ...entry,
        status: entry.status === "failed" ? "failed" : "queued",
      }));
  } catch {
    return [];
  }
}

let entries = restore();
let delivering = false;
const listeners = new Set<() => void>();
function publish(next: Entry[]) {
  entries = next;
  const pending = next.filter((entry) => entry.status !== "sent");
  try {
    if (pending.length)
      conversationStorage().setItem(storageKey, JSON.stringify(pending));
    else conversationStorage().removeItem(storageKey);
  } catch {
    /* Keep the in-memory queue usable when tab storage is full. */
  }
  for (const notify of listeners) notify();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useOutbox() {
  return useSyncExternalStore(subscribe, () => entries);
}

// Keep the original key and reply context even if the response is lost or the
// user opens another view. The server handles submissions in receipt order.
async function deliver() {
  if (delivering) return;
  delivering = true;
  try {
    let entry;
    while ((entry = entries.find((row) => row.status === "queued"))) {
      const { submission } = entry;
      const change = (fields: Partial<Entry>) =>
        publish(
          entries.map((row) =>
            row.submission.key === submission.key ? { ...row, ...fields } : row,
          ),
        );
      change({ status: "sending", error: undefined });
      try {
        const receipt = await api("/conversation/messages", submission);
        change({
          status: "sent",
          seq: receipt.seq,
          created: receipt.created ?? entry.created,
          submission: {
            ...submission,
            text: receipt.body ?? redact(submission.text),
          },
        });
      } catch (e) {
        change({
          status: "failed",
          error:
            e instanceof TypeError
              ? "暂时无法连接工作台"
              : (e as Error).message,
        });
      }
    }
  } finally {
    delivering = false;
  }
}

export function queueMessage(submission: Submission) {
  if (entries.some((entry) => entry.submission.key === submission.key)) return;
  publish([
    ...entries,
    { submission, created: new Date().toISOString(), status: "queued" },
  ]);
  void deliver();
}
export function retryMessage(id: string) {
  publish(
    entries.map((row) =>
      row.submission.key === id && row.status === "failed"
        ? { ...row, status: "queued" }
        : row,
    ),
  );
  void deliver();
}
export function reconcileOutbox(rows: Data[]) {
  const ids = new Set(rows.map((row) => row.id));
  const remaining = entries.filter((row) => !ids.has(row.submission.key));
  if (remaining.length !== entries.length) publish(remaining);
  if (remaining.some((row) => row.status === "queued")) void deliver();
}
export function outgoingRow(entry: Entry): Data {
  return {
    id: entry.submission.key,
    role: "user",
    kind: "message",
    body: redact(entry.submission.text),
    created: entry.created,
    seq: entry.seq ?? Infinity,
    refs: [],
    delivery: entry.status,
    error: entry.error,
  };
}
