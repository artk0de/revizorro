import { z } from "zod";
import { FileRange } from "./range.js";

const threadAnchor = {
  threadId: z.string(),
  file: z.string(),
  range: FileRange,
  body: z.string(),
};

export const QuestionEvent = z.object({ type: z.literal("question"), ...threadAnchor });
export const CommentEvent = z.object({ type: z.literal("comment"), ...threadAnchor });
export const DecisionEvent = z.object({
  type: z.literal("decision"),
  verdict: z.enum(["approved", "declined"]),
  comments: z.array(z.object(threadAnchor)).default([]),
});
export const IdleEvent = z.object({ type: z.literal("idle") });

export const ReviewEvent = z.discriminatedUnion("type", [
  QuestionEvent,
  CommentEvent,
  DecisionEvent,
  IdleEvent,
]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;
