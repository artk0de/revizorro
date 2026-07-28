import { HttpReviewHost, FsSessionStore, GitDiffProvider } from "@revizorro/core-adapters";
import {
  startRound,
  applyPush,
  applyDecision,
  markVerdictDelivered,
  markVerdictPending,
  isVerdictReplayable,
  editMessage,
  type DiffFile,
  type ReviewOptions,
} from "@revizorro/core";
import type {
  SessionState,
  FileRange,
  PushPayload,
  ReviewEvent,
  Side,
} from "@revizorro/protocol";

/** Everything needed to review one repoRoot; rebuilt when the CLI targets another. */
interface ReviewCtx {
  repoRoot: string;
  worktreeId: string;
  /** The CLI asked to review the index only — unstaged edits stay out of the diff. */
  stagedOnly: boolean;
  store: FsSessionStore;
  diff: GitDiffProvider;
  lastDiff: DiffFile[];
}

/**
 * Review session host. Owns the HTTP event broker; the persisted session and diff
 * are keyed by the repoRoot the CLI sends, so a single VS Code window can review
 * ANY project's worktree — not only the one it happens to have open. The form
 * calls the emit* methods when the human acts; each emit unblocks one waiting CLI.
 */
export class ReviewHost {
  readonly events = new HttpReviewHost();
  /** Thread ids awaiting an agent reply (Ask agent) — drives the form's loader. */
  private readonly pending = new Set<string>();
  /** The review currently shown in the form (the last repoRoot a CLI asked for). */
  private current?: ReviewCtx;

  constructor(
    private readonly onState: (s: SessionState, diff: DiffFile[]) => void,
    private readonly onOpen: (s: SessionState, diff: DiffFile[]) => void,
  ) {
    this.events.onPush((wt, repoRoot, push, opts) => {
      void this.handlePush(this.ctx(repoRoot, wt, opts), push);
    });
    // The form appears when the agent runs `review` — not on activation/reload.
    this.events.onReview((wt, repoRoot, opts) => {
      void this.openForReview(this.ctx(repoRoot, wt, opts));
    });
  }

  isPending(threadId: string): boolean {
    return this.pending.has(threadId);
  }

  /** Highest numeric suffix across existing thread ids — so new ids never collide after a restart. */
  private maxId(threads: SessionState["threads"]): number {
    return threads.reduce((m, t) => {
      const n = parseInt(t.id.replace(/\D/g, ""), 10);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
  }

  /** Get (or build) the session context for a repoRoot, making it the active review. */
  private ctx(repoRoot: string, worktreeId: string, opts: ReviewOptions = {}): ReviewCtx {
    const stagedOnly = opts.stagedOnly === true;
    // The diff source is baked into the provider, so switching --staged-only mid-flight
    // has to rebuild the context (and drop the cached diff) rather than reuse it.
    if (this.current?.repoRoot !== repoRoot || this.current.stagedOnly !== stagedOnly) {
      this.current = {
        repoRoot,
        worktreeId,
        stagedOnly,
        store: new FsSessionStore(repoRoot),
        diff: new GitDiffProvider(repoRoot, undefined, { stagedOnly }),
        lastDiff: [],
      };
    }
    return this.current;
  }

  /** Start the HTTP broker and return its port (the extension registers it globally). */
  async start(): Promise<number> {
    return this.events.start();
  }

  async stop(): Promise<void> {
    return this.events.stop();
  }

  /** Open the form for a `review` call: re-render the open round, or start a fresh one. */
  private async openForReview(c: ReviewCtx): Promise<void> {
    const cur = await c.store.load(c.worktreeId);
    if (cur?.status === "open") {
      if (c.lastDiff.length === 0) c.lastDiff = await c.diff.diff(c.worktreeId);
      this.onOpen(cur, c.lastDiff);
      return;
    }
    // A verdict decided moments ago that never reached an agent — the human hit
    // approve while the CLI was still starting its poll. Hand it over now. Past the
    // replay window this is a request for the NEXT round, not a question about the
    // last one, so a stale approval must not be served here.
    if (cur && isVerdictReplayable(cur, Date.now())) {
      await c.store.save(markVerdictDelivered(cur));
      this.events.emit(c.worktreeId, this.verdictEvent(cur));
      return;
    }
    const s = await this.newRound(c);
    this.onOpen(s, c.lastDiff);
  }

  /** Open threads handed to the agent alongside a verdict (or a clarify request). */
  private openComments(s: SessionState): {
    threadId: string;
    file: string;
    side: Side;
    range: FileRange;
    body: string;
  }[] {
    return s.threads
      .filter((t) => !t.resolved)
      .map((t) => ({
        threadId: t.id,
        file: t.file,
        side: t.side,
        range: t.range,
        body: t.messages.map((m) => m.body).join("\n"),
      }));
  }

  private verdictEvent(s: SessionState): ReviewEvent {
    return s.status === "approved"
      ? { type: "decision", verdict: "approved", comments: [] }
      : { type: "decision", verdict: "changes_requested", comments: this.openComments(s) };
  }

  /** Emit a verdict; if no agent was listening, leave it briefly replayable. */
  private async deliverVerdict(c: ReviewCtx, s: SessionState): Promise<void> {
    if (this.events.emit(c.worktreeId, this.verdictEvent(s))) return;
    await c.store.save(markVerdictPending(s, Date.now()));
  }

  /** Recompute the diff and open a fresh review round (collapsing unchanged viewed files). */
  private async newRound(c: ReviewCtx): Promise<SessionState> {
    const prev = await c.store.load(c.worktreeId);
    c.lastDiff = await c.diff.diff(c.worktreeId);
    const s = startRound(prev, c.worktreeId, c.lastDiff);
    await c.store.save(s);
    return s;
  }

  /** Apply an agent push: append replies/comments, clear pending loaders, persist, re-render. */
  private async handlePush(c: ReviewCtx, push: PushPayload): Promise<void> {
    const cur = await c.store.load(c.worktreeId);
    if (!cur) return;
    let n = this.maxId(cur.threads);
    const next = applyPush(cur, push, () => `t${++n}`);
    for (const r of push.replies) this.pending.delete(r.threadId);
    await c.store.save(next);
    // A push can be the first call on a fresh context (e.g. the agent flipped
    // --staged-only mid-round), and rendering that cache empty would blank the form.
    if (c.lastDiff.length === 0) c.lastDiff = await c.diff.diff(c.worktreeId);
    // An agent push during an OPEN review must (re)show the form — the human may
    // have closed or reloaded the window (e.g. mid-Clarify). A decided session
    // (approved/changes_requested) stays closed: onState only re-renders if open.
    if (next.status === "open") this.onOpen(next, c.lastDiff);
    else this.onState(next, c.lastDiff);
  }

  async approve(): Promise<void> {
    const c = this.current;
    if (!c) return;
    await this.deliverVerdict(c, await this.finalize(c, "approved"));
  }

  /**
   * The human closed the form without a verdict. Only signal `closed` while the
   * session is still open — a decided (approved/changes_requested) session has
   * already unblocked the agent, so its late dispose must stay silent.
   */
  async abandon(): Promise<void> {
    const c = this.current;
    if (!c) return;
    const cur = await c.store.load(c.worktreeId);
    if (cur?.status === "open") this.events.emit(c.worktreeId, { type: "closed" });
  }

  /** Request changes: the agent fixes every open comment and re-submits a new round. */
  async requestChanges(): Promise<void> {
    const c = this.current;
    if (!c) return;
    await this.deliverVerdict(c, await this.finalize(c, "changes_requested"));
  }

  /**
   * Clarify: the agent answers every open thread (no code changes). The form stays
   * open; open threads are marked pending so the loaders show until each is answered.
   */
  async clarify(): Promise<void> {
    const c = this.current;
    if (!c) return;
    const cur = await c.store.load(c.worktreeId);
    if (!cur) return;
    for (const t of cur.threads.filter((t) => !t.resolved)) this.pending.add(t.id);
    this.onState(cur, c.lastDiff);
    this.events.emit(c.worktreeId, {
      type: "decision",
      verdict: "clarify",
      comments: this.openComments(cur),
    });
  }

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
    const c = this.current;
    if (!c) return;
    const cur = await c.store.load(c.worktreeId);
    if (!cur) return;
    const threadId = `t${this.maxId(cur.threads) + 1}`;
    const next: SessionState = {
      ...cur,
      threads: [
        ...cur.threads,
        { id: threadId, file, side, range, messages: [{ author: "human", body }], resolved: false },
      ],
    };
    if (ask) this.pending.add(threadId);
    await c.store.save(next);
    this.onState(next, c.lastDiff);
    this.events.emit(c.worktreeId, {
      type: ask ? "question" : "comment",
      threadId,
      file,
      side,
      range,
      body,
    });
  }

  /** Human replies inside an existing thread. `ask=true` wakes the agent now. */
  async addHumanReply(threadId: string, body: string, ask = false): Promise<void> {
    const c = this.current;
    if (!c) return;
    const cur = await c.store.load(c.worktreeId);
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
    await c.store.save(next);
    this.onState(next, c.lastDiff);
    this.events.emit(c.worktreeId, {
      type: ask ? "question" : "comment",
      threadId,
      file: thread.file,
      side: thread.side,
      range: thread.range,
      body,
    });
  }

  /** Edit one of the human's own messages in a thread; persist and re-render. */
  async editMessage(threadId: string, index: number, body: string): Promise<void> {
    const c = this.current;
    if (!c) return;
    const cur = await c.store.load(c.worktreeId);
    if (!cur) return;
    const next = editMessage(cur, threadId, index, body);
    await c.store.save(next);
    this.onState(next, c.lastDiff);
  }

  /** Mark a thread resolved/unresolved; persist and re-render. Resolved threads drop from the next round. */
  async resolveThread(threadId: string, resolved: boolean): Promise<void> {
    const c = this.current;
    if (!c) return;
    const cur = await c.store.load(c.worktreeId);
    if (!cur) return;
    const next: SessionState = {
      ...cur,
      threads: cur.threads.map((t) => (t.id === threadId ? { ...t, resolved } : t)),
    };
    await c.store.save(next);
    this.onState(next, c.lastDiff);
  }

  /** Human marks/unmarks a file as viewed; persist and re-render (no event). */
  async setViewed(file: string, viewed: boolean): Promise<void> {
    const c = this.current;
    if (!c) return;
    const cur = await c.store.load(c.worktreeId);
    if (!cur?.files[file]) return;
    const next: SessionState = {
      ...cur,
      files: { ...cur.files, [file]: { ...cur.files[file], viewed } },
    };
    await c.store.save(next);
    this.onState(next, c.lastDiff);
  }

  private async finalize(
    c: ReviewCtx,
    verdict: "approved" | "changes_requested",
  ): Promise<SessionState> {
    const cur = (await c.store.load(c.worktreeId)) ?? (await this.newRound(c));
    // Persisted as delivered up front: the agent re-reads the session as soon as the
    // event lands, and must never find a verdict that still looks pending — that
    // would replay it a second time. deliverVerdict undoes this if nobody listened.
    const next = markVerdictDelivered(applyDecision(cur, verdict));
    await c.store.save(next);
    return next;
  }
}
