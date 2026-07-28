import type { SessionState } from "@revizorro/protocol";
import { decideCollapsed, type DiffFile } from "./collapse.js";

export function startRound(
  prev: SessionState | null,
  worktreeId: string,
  diff: DiffFile[],
): SessionState {
  const round = prev ? prev.round + 1 : 1;
  const { files } = decideCollapsed(prev?.files ?? {}, diff);
  const threads = (prev?.threads ?? []).filter((t) => !t.resolved);
  return { worktreeId, round, status: "open", files, threads, verdictDelivered: false };
}

export function applyDecision(
  state: SessionState,
  verdict: "approved" | "changes_requested",
): SessionState {
  return { ...state, status: verdict, verdictDelivered: false };
}

/** Record that an agent has actually received the verdict, so it is never replayed twice. */
export function markVerdictDelivered(state: SessionState): SessionState {
  return { ...state, verdictDelivered: true, verdictPendingSince: undefined };
}

/**
 * How long an undelivered verdict stays replayable. This exists to close one narrow
 * race — the human decides in the instant between the agent launching `review` and
 * its long poll being registered — NOT to resurrect old decisions. Past the window a
 * `review` call means "start the next round", and replaying a stale approval there
 * would answer a question the agent never asked.
 */
export const VERDICT_REPLAY_WINDOW_MS = 120_000;

/** Mark a verdict nobody was listening for, starting its replay window at `now`. */
export function markVerdictPending(state: SessionState, now: number): SessionState {
  return { ...state, verdictDelivered: false, verdictPendingSince: now };
}

export function isVerdictReplayable(
  state: SessionState,
  now: number,
  windowMs: number = VERDICT_REPLAY_WINDOW_MS,
): boolean {
  if (state.status === "open" || state.verdictDelivered) return false;
  const since = state.verdictPendingSince;
  return since !== undefined && now - since < windowMs;
}
