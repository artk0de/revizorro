import type { FsSessionStore } from "@revizorro/core-adapters";
import { editMessage as editThreadMessage } from "@revizorro/core";
import type { SessionState, FileRange, Side } from "@revizorro/protocol";

import type { FormRenderer } from "./form-renderer.js";
import type { ReviewSessionDeps } from "./session.js";

/** Highest numeric suffix across existing thread ids — so new ids never collide after a restart. */
export function maxThreadId(threads: SessionState["threads"]): number {
  return threads.reduce((m, t) => {
    const n = parseInt(t.id.replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
}

/**
 * Applies what the human does on one review's form — new threads, replies, edits,
 * resolutions, viewed marks — to the persisted round, and re-renders it. Only "Ask
 * agent" reaches the agent from here; everything else travels with the verdict.
 */
export class HumanInput {
  constructor(
    private readonly worktreeId: string,
    private readonly store: FsSessionStore,
    /** Thread ids awaiting an agent reply, shared with the session that owns them. */
    private readonly pending: Set<string>,
    private readonly form: FormRenderer,
    private readonly emit: ReviewSessionDeps["emit"],
  ) {}

  /**
   * Human opens a new thread on a line. `ask=true` wakes the agent for an immediate
   * reply (question event); otherwise it is a passive comment.
   */
  async addHumanComment(
    file: string,
    range: FileRange,
    body: string,
    ask = false,
    side: Side = "new",
  ): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur) return;
    const threadId = `t${maxThreadId(cur.threads) + 1}`;
    const next: SessionState = {
      ...cur,
      threads: [
        ...cur.threads,
        { id: threadId, file, side, range, messages: [{ author: "human", body }], resolved: false },
      ],
    };
    if (ask) this.pending.add(threadId);
    await this.store.save(next);
    this.form.render(next);
    // Only "Ask agent" asks for the agent's attention. A passive comment is a note
    // the human leaves mid-read: it is already saved, and it reaches the agent
    // inside the verdict. Waking the loop for it would send the agent off fixing
    // half a review before the human has decided anything.
    // Held when the agent is between calls (off writing the previous answer):
    // a question the human asked must never be silently dropped.
    if (ask) {
      this.emit(this.worktreeId, { type: "question", threadId, file, side, range, body }, true);
    }
  }

  /** Human replies inside an existing thread. `ask=true` wakes the agent now. */
  async addHumanReply(threadId: string, body: string, ask = false): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur) return;
    const thread = cur.threads.find((t) => t.id === threadId);
    if (!thread) return;
    const next: SessionState = {
      ...cur,
      threads: cur.threads.map((t) =>
        t.id === threadId ? { ...t, messages: [...t.messages, { author: "human", body }] } : t,
      ),
    };
    if (ask) this.pending.add(threadId);
    await this.store.save(next);
    this.form.render(next);
    // Same rule as a new thread: only Ask agent wakes the loop. A plain reply is
    // recorded and travels with the verdict.
    if (ask) {
      this.emit(
        this.worktreeId,
        {
          type: "question",
          threadId,
          file: thread.file,
          side: thread.side,
          range: thread.range,
          body,
        },
        true,
      );
    }
  }

  /** Edit one of the human's own messages in a thread; persist and re-render. */
  async editMessage(threadId: string, index: number, body: string): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur) return;
    const next = editThreadMessage(cur, threadId, index, body);
    await this.store.save(next);
    this.form.render(next);
  }

  /** Mark a thread resolved/unresolved; persist and re-render. Resolved threads drop from the next round. */
  async resolveThread(threadId: string, resolved: boolean): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur) return;
    const next: SessionState = {
      ...cur,
      threads: cur.threads.map((t) => (t.id === threadId ? { ...t, resolved } : t)),
    };
    // A closed thread has nothing left to wait for: the human stopped waiting
    // for the answer, so it must stop counting as one the agent owes.
    if (resolved) this.pending.delete(threadId);
    await this.store.save(next);
    this.form.render(next);
  }

  /** Human marks/unmarks a file as viewed; persist and re-render (no event). */
  async setViewed(file: string, viewed: boolean): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur?.files[file]) return;
    const next: SessionState = {
      ...cur,
      files: { ...cur.files, [file]: { ...cur.files[file], viewed } },
    };
    await this.store.save(next);
    this.form.render(next);
  }
}
