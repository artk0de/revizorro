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
  return { ...state, verdictDelivered: true };
}
