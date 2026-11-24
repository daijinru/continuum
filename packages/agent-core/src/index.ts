export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_approval"
  | "unknown"
  | "succeeded"
  | "failed"
  | "interrupted";
const next: Record<RunStatus, RunStatus[]> = {
  queued: ["starting", "failed", "interrupted"],
  starting: ["running", "unknown", "failed", "interrupted"],
  running: [
    "waiting_approval",
    "succeeded",
    "failed",
    "interrupted",
    "unknown",
  ],
  waiting_approval: [
    "running",
    "succeeded",
    "failed",
    "interrupted",
    "unknown",
  ],
  unknown: ["running", "succeeded", "failed", "interrupted"],
  succeeded: [],
  failed: [],
  interrupted: [],
};
export const canMove = (from: RunStatus, to: RunStatus) =>
  next[from].includes(to);
export type Observation = {
  key: string;
  type: string;
  title: string;
  method?: string;
  unit?: string;
  time?: string;
  data?: Record<string, unknown>;
  path?: string;
  approval?: {
    id: string;
    action: string;
    reason: string;
    scope: string;
    risk: string;
    kind?: "approval" | "input";
    blocking?: boolean;
  };
};
export type Sink = (event: Observation) => void;
export type Context = {
  id: string;
  workspace: string;
  managedCommission?: boolean;
  instruction: string;
  thread?: string;
  turn?: string;
  reference: (thread: string, turn?: string) => void;
  emit: Sink;
};
export interface AgentAdapter {
  start(context: Context): Promise<void>;
  respond(
    id: string,
    request: string,
    decision: "approve" | "deny",
  ): Promise<void>;
  answer?(
    id: string,
    request: string,
    answers: Record<string, string>,
  ): Promise<void>;
  interrupt(id: string): Promise<void>;
  reconcile(context: Context): Promise<RunStatus>;
  close(): void;
}
export function redact(value: string) {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi,
      "[已隐藏]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, "[已隐藏]")
    .replace(
      /\b(?:sk-[\w-]{8,}|gh[pousr]_[\w-]{8,}|github_pat_[\w-]+|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g,
      "[已隐藏]",
    )
    .replace(
      /(["']?[\w.-]*(?:token|secret|password|api[_-]?key|authorization|cookie|credential)[\w.-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[已隐藏]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已隐藏]@")
    .slice(0, 4000);
}
