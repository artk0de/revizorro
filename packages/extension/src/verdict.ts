import { threadsInDiff } from "@revizorro/core";
import type { SessionState, FileRange, ReviewEvent, Side } from "@revizorro/protocol";

/** One open thread as the agent receives it with a verdict or a clarify request. */
export interface OpenComment {
  threadId: string;
  file: string;
  side: Side;
  range: FileRange;
  body: string;
}

/**
 * Open threads handed to the agent alongside a verdict (or a clarify request) —
 * only those on files in the diff under review. The session keeps threads from
 * earlier rounds and other scopes, and shipping all of them would tell the agent
 * to go fix work that shipped days ago.
 */
export function openComments(s: SessionState, diffPaths: string[]): OpenComment[] {
  return threadsInDiff(s, diffPaths).map((t) => ({
    threadId: t.id,
    file: t.file,
    side: t.side,
    range: t.range,
    body: t.messages.map((m) => m.body).join("\n"),
  }));
}

/** The decision event a decided round sends; only changes_requested carries comments. */
export function verdictEvent(s: SessionState, diffPaths: string[]): ReviewEvent {
  return s.status === "approved"
    ? { type: "decision", verdict: "approved", comments: [] }
    : { type: "decision", verdict: "changes_requested", comments: openComments(s, diffPaths) };
}
