import { z } from "zod";
export const line = z.string().trim().min(1).max(4000);
const lines = z.array(line).max(30);
export const goalInput = z
  .object({
    title: line.max(120),
    description: line,
    criteria: lines.min(1),
    constraints: lines.default([]),
    workspaceId: z.string().uuid(),
    provider: z.enum(["demo", "codex"]),
    priority: z.number().int().min(1).max(5).default(3),
  })
  .strict();
export const states = z.enum([
  "draft",
  "active",
  "paused",
  "blocked",
  "completed",
  "archived",
]);
export const decisionInput = z
  .object({
    decision: z.enum(["approve", "deny", "defer", "answer", "record"]),
    answers: z.record(line.max(1000)).optional(),
    observed: z.enum(["succeeded", "failed", "interrupted"]).optional(),
    note: line.optional(),
    version: z.number().int().positive(),
    key: z.string().uuid(),
  })
  .strict();
export const startInput = z
  .object({
    instruction: line.optional(),
    key: z.string().uuid(),
    continue: z.boolean().default(false),
  })
  .strict();
export const scheduleInput = z
  .object({
    kind: z.enum(["one_off", "interval"]),
    instruction: line,
    minutes: z.number().int().min(1).max(525600),
    nextAt: z.string().datetime(),
  })
  .strict();
export const settingsInput = z
  .object({
    dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    budget: z.number().int().min(1).max(48),
    maxMinutes: z.number().int().min(1).max(240),
    cooldown: z.number().int().min(0).max(1440),
  })
  .partial()
  .strict();
export const chatInput = z
  .object({
    scope: z.enum(["all", "goal", "story", "approval"]),
    ref: z.string().min(1),
    goalId: z.string().uuid(),
    content: line,
  })
  .strict();
export const windowInput = z.enum(["since", "today", "week"]);
export type GoalInput = z.infer<typeof goalInput>;
