import { z } from "zod";
import { FileRange, Side } from "./range.js";

const threadAnchor = {
  threadId: z.string(),
  file: z.string(),
  side: Side.default("new"),
  range: FileRange,
  body: z.string(),
};

/**
 * Stamped on every event so the agent can judge an event on its own, without
 * guessing from call timings: `at` is when the human acted, `held` says the event
 * waited in the queue because the agent was away. A verdict arriving instantly is
 * normal when it was held — it is fresh, just delivered late.
 */
const provenance = {
  at: z.number().optional(),
  held: z.boolean().optional(),
};

export const QuestionEvent = z.object({
  type: z.literal("question"),
  ...threadAnchor,
  ...provenance,
});
export const CommentEvent = z.object({
  type: z.literal("comment"),
  ...threadAnchor,
  ...provenance,
});
export const DecisionEvent = z.object({
  type: z.literal("decision"),
  // approved → flow passes; changes_requested → agent fixes + new round;
  // clarify → agent answers all open questions, form stays open.
  verdict: z.enum(["approved", "changes_requested", "clarify"]),
  comments: z.array(z.object(threadAnchor)).default([]),
  ...provenance,
});
/**
 * The poll hit its cutoff with the human still reading. Carries a snapshot of the
 * live review so the agent can see at a glance that the round is open and simply
 * re-arm, instead of going off to diagnose a form that is working fine.
 */
export const IdleEvent = z.object({
  type: z.literal("idle"),
  review: z
    .object({
      round: z.number(),
      files: z.number(),
      openThreads: z.number(),
      viewedFiles: z.number(),
    })
    .optional(),
  ...provenance,
});
// The human closed the review form without a verdict — the agent must ask the
// user how to proceed instead of blocking forever on the next event.
export const ClosedEvent = z.object({ type: z.literal("closed"), ...provenance });

export const ReviewEvent = z.discriminatedUnion("type", [
  QuestionEvent,
  CommentEvent,
  DecisionEvent,
  IdleEvent,
  ClosedEvent,
]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;
