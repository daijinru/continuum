import { z } from "zod";

export const pageEvent = z.object({
  stage: z.enum(["queued", "sending", "send_failed", "accepted", "connected", "disconnected",
    "notice", "visible", "hidden", "applied", "on_screen", "load_failed"]),
  at: z.string().datetime(),
  message: z.string().uuid().optional(),
  version: z.number().int().nonnegative().safe().optional(),
}).strict();

export const pageLog = z.object({
  page: z.string().uuid(),
  events: z.array(pageEvent).min(1).max(64),
}).strict();
export type PageEvent = z.infer<typeof pageEvent>;
