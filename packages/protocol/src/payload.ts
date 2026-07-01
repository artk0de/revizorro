import { z } from "zod";
import { FileRange, Side } from "./range.js";

export const AgentReply = z.object({ threadId: z.string(), body: z.string() });
export const AgentComment = z.object({
  file: z.string(),
  side: Side.default("new"),
  range: FileRange,
  body: z.string(),
});

export const PushPayload = z.object({
  replies: z.array(AgentReply).default([]),
  comments: z.array(AgentComment).default([]),
});
export type PushPayload = z.infer<typeof PushPayload>;
