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

export function applyPush(
  state: SessionState,
  payload: PushPayload,
  idGen: () => string,
): SessionState {
  const threads = state.threads.map((t) => ({ ...t, messages: [...t.messages] }));
  for (const r of payload.replies) {
    const t = threads.find((x) => x.id === r.threadId);
    if (t) t.messages.push({ author: "agent", body: r.body });
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
  }
  return { ...state, threads };
}
