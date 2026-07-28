/**
 * Keys for text the human has typed but not sent yet.
 *
 * Every agent push re-renders the whole form, which throws away the DOM the human
 * was typing into. Drafts are kept outside that DOM and restored afterwards, so
 * keys must stay stable across renders and never collide — a reply meant for one
 * thread reappearing under another would be worse than losing it.
 *
 * Values are JSON-encoded rather than concatenated so ids or paths containing the
 * separator cannot forge another key.
 */
const key = (kind: string, ...parts: (string | number)[]): string =>
  `${kind}:${JSON.stringify(parts)}`;

/** A new comment being composed on a line range. */
export function composeDraftKey(
  file: string,
  side: string,
  startLine: number,
  endLine: number,
): string {
  return key("compose", file, side, startLine, endLine);
}

/** A reply being typed into an existing thread. */
export function replyDraftKey(threadId: string): string {
  return key("reply", threadId);
}

/** An edit in progress on one of the human's own messages. */
export function editDraftKey(threadId: string, index: number): string {
  return key("edit", threadId, index);
}
