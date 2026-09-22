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
 * Stamped on every event so the agent can judge it without measuring anything of
 * its own: `at` is when the human acted, `held` says the event waited in the queue
 * because the agent was away. A verdict arriving instantly is normal when it was
 * held — it is fresh, just delivered late.
 *
 * The durations are the numbers an agent would otherwise time around the command or
 * add up from heartbeats: `reviewMs` is how long the round has been running (the
 * host knows, from the round's own start), `waitedMs` is how long the delivering
 * call blocked, and `ageMs` is how long ago the human acted — the one that
 * separates a queued verdict handed over seconds later from a replay of an earlier
 * round, which `held` alone cannot. The CLI knows the last two, having made the
 * call. `reviewFor`, `waited` and `age` are those numbers spelled for a human, so
 * quoting one costs no arithmetic.
 */
const provenance = {
  at: z.number().optional(),
  held: z.boolean().optional(),
  reviewMs: z.number().optional(),
  reviewFor: z.string().optional(),
  waitedMs: z.number().optional(),
  waited: z.string().optional(),
  ageMs: z.number().optional(),
  age: z.string().optional(),
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
  /**
   * How long the form has gone untouched, in milliseconds. A measurement, not a
   * verdict: what counts as "the human left" is the agent's policy and lives in
   * the skill. Optional so an older host paired with a newer CLI still parses.
   */
  inactiveForMs: z.number().optional(),
  /** The same measurement spelled for a human — the units the idle policy is written in. */
  inactiveFor: z.string().optional(),
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
