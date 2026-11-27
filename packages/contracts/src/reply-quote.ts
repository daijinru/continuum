import { z } from "zod";

export const replyQuote = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    id: z.string().uuid(),
    text: z.string(),
    role: z.enum(["user", "assistant"]),
    kind: z.string(),
    created: z.string(),
    origin: z.string().nullish(),
  }),
  z.object({ type: z.literal("goal"), id: z.string().uuid(), text: z.string() }),
]);

export type ReplyQuote = z.infer<typeof replyQuote>;
