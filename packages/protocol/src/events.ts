import { z } from "zod";
import { FileRange, Side } from "./range.js";

const threadAnchor = {
  threadId: z.string(),
  file: z.string(),
  side: Side.default("new"),
  range: FileRange,
  body: z.string(),
};

export const QuestionEvent = z.object({ type: z.literal("question"), ...threadAnchor });
export const CommentEvent = z.object({ type: z.literal("comment"), ...threadAnchor });
export const DecisionEvent = z.object({
  type: z.literal("decision"),
  // approved → flow passes; changes_requested → agent fixes + new round;
  // clarify → agent answers all open questions, form stays open.
  verdict: z.enum(["approved", "changes_requested", "clarify"]),
  comments: z.array(z.object(threadAnchor)).default([]),
});
export const IdleEvent = z.object({ type: z.literal("idle") });
// The human closed the review form without a verdict — the agent must ask the
// user how to proceed instead of blocking forever on the next event.
export const ClosedEvent = z.object({ type: z.literal("closed") });

export const ReviewEvent = z.discriminatedUnion("type", [
  QuestionEvent,
  CommentEvent,
  DecisionEvent,
  IdleEvent,
  ClosedEvent,
]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;
