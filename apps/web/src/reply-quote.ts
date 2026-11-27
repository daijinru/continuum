import type { Data } from "./lib.tsx";

import type { ReplyQuote } from "../../../packages/contracts/src/reply-quote.ts";
export type { ReplyQuote } from "../../../packages/contracts/src/reply-quote.ts";

export function messageQuote(m: Data): ReplyQuote {
  return {
    type: "message", id: m.id, text: m.body.slice(0, 240),
    role: m.role, kind: m.kind, created: m.created, origin: m.origin,
  };
}

export function sender(role: string, kind: string) {
  if (role === "user") return "你";
  if (kind === "reminder") return "提醒";
  if (kind === "history") return "以往交付";
  return "Continuum";
}

export function messageTime(created: string) {
  return new Date(created).toLocaleTimeString("zh-CN", {
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
