import type { SessionState, PushPayload } from "@revizorro/protocol";

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
      range: c.range,
      messages: [{ author: "agent", body: c.body }],
      resolved: false,
    });
  }
  return { ...state, threads };
}
