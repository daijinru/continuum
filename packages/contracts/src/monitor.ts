import { z } from "zod";

const id = z.string().uuid();
export const monitor = z.object({
  sampledAt: z.string().datetime(),
  processes: z
    .array(
      z.object({
        pid: z.number().int().positive(),
        role: z.enum(["service", "executor", "helper"]),
        runId: id.nullable(),
        cpu: z.number().nonnegative(),
        rssMiB: z.number().nonnegative(),
      }),
    )
    .nullable(),
  tasks: z.array(
    z.object({
      id,
      title: z.string(),
      runId: id.nullable(),
      nextAt: z.string().nullable(),
      demo: z.boolean(),
      state: z.enum([
        "running",
        "starting",
        "watching",
        "waiting_approval",
        "unknown",
        "scheduled",
        "queued",
        "paused",
        "idle",
        "blocked",
      ]),
    }),
  ),
});
export type MonitorSnapshot = z.infer<typeof monitor>;
