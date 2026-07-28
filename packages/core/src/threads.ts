import type { SessionState, PushPayload } from "@revizorro/protocol";

/** Edit a human-authored message body in place. Agent messages are immutable. */
export function editMessage(
  state: SessionState,
  threadId: string,
  index: number,
  body: string,
): SessionState {
  return {
    ...state,
    threads: state.threads.map((t) => {
      if (t.id !== threadId) return t;
      if (t.messages[index]?.author !== "human") return t;
      return { ...t, messages: t.messages.map((m, i) => (i === index ? { ...m, body } : m)) };
    }),
  };
}

/**
 * The unresolved threads that belong to what the human is reviewing right now.
 *
 * A session outlives its rounds: threads survive scope switches, closed MRs, even
 * another branch reviewed in the same window, and files they point at may be long
 * gone. Handing all of them to the agent with a verdict reads as "fix all this",
 * when most of it is history — so a verdict only carries threads on files in the
 * current diff.
 */
export function threadsInDiff(state: SessionState, diffPaths: readonly string[]): SessionState["threads"] {
  const inDiff = new Set(diffPaths);
  return state.threads.filter((t) => !t.resolved && inDiff.has(t.file));
}

export function applyPush(
  state: SessionState,
  payload: PushPayload,
  idGen: () => string,
): SessionState {
  const threads = state.threads.map((t) => ({ ...t, messages: [...t.messages] }));
  const touched = new Set<string>();
  for (const r of payload.replies) {
    const t = threads.find((x) => x.id === r.threadId);
    if (!t) continue;
    t.messages.push({ author: "agent", body: r.body });
    touched.add(t.file);
  }
  for (const c of payload.comments) {
    threads.push({
      id: idGen(),
      file: c.file,
      side: c.side,
      range: c.range,
      messages: [{ author: "agent", body: c.body }],
      resolved: false,
    });
    touched.add(c.file);
  }
  // A viewed file renders collapsed, so a fresh agent message inside it would stay
  // invisible — every file this push touches goes back to un-viewed.
  const files = { ...state.files };
  for (const path of touched) {
    const f = files[path];
    if (f?.viewed) files[path] = { ...f, viewed: false };
  }
  return { ...state, files, threads };
}
