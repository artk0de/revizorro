import {
  HttpReviewHost,
  FsSessionStore,
  GitDiffProvider,
  worktreeIdFor,
} from "@revizorro/core-adapters";
import {
  startRound,
  decideCollapsed,
  applyPush,
  applyDecision,
  markVerdictDelivered,
  markVerdictPending,
  markInterrupted,
  isVerdictReplayable,
  scopeChanged,
  resolveScope,
  threadsInDiff,
  editMessage,
  type DiffFile,
  type ReviewOptions,
} from "@revizorro/core";
import type {
  SessionState,
  FileRange,
  PushPayload,
  ReviewEvent,
  ReviewScope,
  Side,
} from "@revizorro/protocol";

/** Everything needed to review one repoRoot; rebuilt when the CLI targets another. */
interface ReviewCtx {
  repoRoot: string;
  worktreeId: string;
  /** The CLI asked to review the index only — unstaged edits stay out of the diff. */
  stagedOnly: boolean;
  /** Branch under review. Part of the session key, so a checkout starts fresh. */
  branch: string;
  /** Target branch the CLI asked to review against ("" = auto-detect). */
  baseRef: string;
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
    private readonly renderState: (s: SessionState, diff: DiffFile[]) => void,
    private readonly openForm: (s: SessionState, diff: DiffFile[]) => void,
  ) {
    this.events.onPush((wt, repoRoot, push, opts) => {
      void this.withCtx(repoRoot, wt, opts, (c) => this.handlePush(c, push));
    });
    // The form appears when the agent runs `review` — not on activation/reload.
    this.events.onReview((wt, repoRoot, opts) => {
      void this.withCtx(repoRoot, wt, opts, (c) => this.openForReview(c));
    });
    // A timed-out poll answers with a snapshot of the live review, so the agent can
    // see the round is open and simply re-arm instead of diagnosing a healthy form.
    this.events.onIdle(() => ({ type: "idle", ...(this.snapshot ? { review: this.snapshot } : {}) }));
    // A long review outlives the CLI call that opened it. Re-render when an agent
    // starts or stops listening so the form can say which.
    this.events.onWaitingChanged((wt) => {
      const c = this.current;
      if (c?.worktreeId !== wt) return;
      void c.store.load(wt).then((s) => {
        // Only a live round is worth repainting. A decided or abandoned one is not
        // on screen, and this fires on the first packet of the NEXT call — which,
        // after a checkout, would flash the previous branch's finished review.
        if (s?.status === "open" && !s.interrupted) this.onStateRendered(s, c.lastDiff);
      });
    });
  }

  isPending(threadId: string): boolean {
    return this.pending.has(threadId);
  }

  /** Last rendered state, summarised for the idle event (read synchronously). */
  private snapshot?: { round: number; files: number; openThreads: number; viewedFiles: number };

  /** Render into the open form, remembering what it shows for the idle snapshot. */
  private onStateRendered(s: SessionState, diff: DiffFile[]): void {
    this.remember(s, diff);
    this.renderState(s, diff);
  }

  /** Open (or re-open) the form, remembering what it shows for the idle snapshot. */
  private onFormOpened(s: SessionState, diff: DiffFile[]): void {
    this.remember(s, diff);
    this.openForm(s, diff);
  }

  private remember(s: SessionState, diff: DiffFile[]): void {
    const paths = new Set(diff.map((f) => f.path));
    this.snapshot = {
      round: s.round,
      files: diff.length,
      openThreads: s.threads.filter((t) => !t.resolved && paths.has(t.file)).length,
      viewedFiles: diff.filter((f) => s.files[f.path]?.viewed).length,
    };
  }

  /** Branch under review, for the form's toolbar. Empty until a round has opened. */
  private branchName = "";
  branch(): string {
    return this.branchName;
  }

  /** Whether an agent is blocked on the active review right now. */
  isAgentWaiting(): boolean {
    return this.current ? this.events.isWaiting(this.current.worktreeId) : false;
  }

  /**
   * The form saw human input. Forwarded to the broker so a long, quiet read does
   * not read as an abandoned review. No open round means nothing to keep alive.
   */
  noteActivity(): void {
    if (this.current) this.events.noteActivity(this.current.worktreeId);
  }

  /** Highest numeric suffix across existing thread ids — so new ids never collide after a restart. */
  private maxId(threads: SessionState["threads"]): number {
    return threads.reduce((m, t) => {
      const n = parseInt(t.id.replace(/\D/g, ""), 10);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
  }

  /**
   * Resolve the scope against the open round before building the context: a call
   * that names no scope keeps reviewing whatever the round is already showing.
   */
  private async withCtx(
    repoRoot: string,
    worktreeId: string,
    opts: ReviewOptions,
    run: (c: ReviewCtx) => Promise<void>,
  ): Promise<void> {
    // Read the branch first: it keys the session, so loading before we know it would
    // look in the previous branch's drawer.
    this.branchName = await new GitDiffProvider(repoRoot).branch();
    const open = await new FsSessionStore(repoRoot, this.branchName).load(worktreeId);
    const scope = resolveScope(open, {
      ...(opts.stagedOnly === undefined ? {} : { stagedOnly: opts.stagedOnly }),
      ...(opts.baseRef === undefined ? {} : { baseRef: opts.baseRef }),
    });
    await run(this.ctx(repoRoot, worktreeId, scope));
  }

  /** Get (or build) the session context for a repoRoot, making it the active review. */
  private ctx(repoRoot: string, worktreeId: string, scope: ReviewScope): ReviewCtx {
    const { stagedOnly, baseRef } = scope;
    // The diff source is baked into the provider, so switching --staged-only or the
    // target branch mid-flight has to rebuild the context (and drop the cached diff).
    if (
      this.current?.repoRoot !== repoRoot ||
      this.current.stagedOnly !== stagedOnly ||
      this.current.baseRef !== baseRef ||
      this.current.branch !== this.branchName
    ) {
      this.current = {
        repoRoot,
        worktreeId,
        stagedOnly,
        baseRef,
        branch: this.branchName,
        store: new FsSessionStore(repoRoot, this.branchName),
        diff: new GitDiffProvider(repoRoot, baseRef || undefined, { stagedOnly }),
        lastDiff: [],
      };
    }
    return this.current;
  }

  /**
   * Bring an unfinished review back after a window reload.
   *
   * The form is opened by the agent's `review` call, and nothing else used to open
   * it — so reloading a window mid-review threw the panel away and left the human
   * with no way to answer, since only the agent can ask for it again. A round that
   * is still open is a review in progress, and the window it belongs to should show
   * it. A decided or abandoned one stays closed: finished work must not pop back up
   * every time a window restarts.
   */
  async restore(repoRoot: string): Promise<void> {
    const branch = await new GitDiffProvider(repoRoot).branch();
    const worktreeId = worktreeIdFor(repoRoot);
    const s = await new FsSessionStore(repoRoot, branch).load(worktreeId);
    if (s?.status !== "open" || s.interrupted) return;

    this.branchName = branch;
    // Reviewing whatever the round was already scoped to — a reload is not a new
    // request, so it must not silently widen a staged-only review to the branch.
    const c = this.ctx(repoRoot, worktreeId, resolveScope(s, {}));
    c.lastDiff = await c.diff.diff(worktreeId);
    // The tree may well have moved while the window was down, so ticks are re-earned
    // the same way any other re-read of the diff earns them.
    const { files } = decideCollapsed(s.files, c.lastDiff);
    const reconciled = { ...s, files };
    await c.store.save(reconciled);
    this.onFormOpened(reconciled, c.lastDiff);
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
    // Continue the open round only when it is showing the SAME review. Asking for
    // the staged change while a whole-branch round is open (or vice versa) is a new
    // review and gets its own round — otherwise the form keeps the old scope.
    if (cur?.status === "open" && !cur.interrupted && !scopeChanged(cur, this.scopeOf(c))) {
      // Always re-read the diff: the agent calls review again precisely because the
      // tree moved on (fixes applied, files staged, work committed).
      c.lastDiff = await c.diff.diff(c.worktreeId);
      // And re-earn the ticks. A viewed mark says "I have read this diff"; once the
      // agent rewrites the file, the human has not read what is now on screen, and a
      // tick left standing invites them to approve code nobody looked at. Continuing
      // a round has to reconcile the marks the same way starting one does.
      const { files } = decideCollapsed(cur.files, c.lastDiff);
      const reconciled = { ...cur, files };
      await c.store.save(reconciled);
      this.onFormOpened(reconciled, c.lastDiff);
      return;
    }
    // A verdict decided moments ago that never reached an agent — the human hit
    // approve while the CLI was still starting its poll. Hand it over now. Past the
    // replay window this is a request for the NEXT round, not a question about the
    // last one, so a stale approval must not be served here.
    if (cur && isVerdictReplayable(cur, Date.now())) {
      await c.store.save(markVerdictDelivered(cur));
      if (c.lastDiff.length === 0) c.lastDiff = await c.diff.diff(c.worktreeId);
      this.events.emit(c.worktreeId, this.verdictEvent(cur, c.lastDiff));
      return;
    }
    const s = await this.newRound(c);
    this.onFormOpened(s, c.lastDiff);
  }

  /**
   * Open threads handed to the agent alongside a verdict (or a clarify request) —
   * only those on files in the diff under review. The session keeps threads from
   * earlier rounds and other scopes, and shipping all of them would tell the agent
   * to go fix work that shipped days ago.
   */
  private openComments(
    s: SessionState,
    diff: DiffFile[],
  ): {
    threadId: string;
    file: string;
    side: Side;
    range: FileRange;
    body: string;
  }[] {
    return threadsInDiff(s, diff.map((f) => f.path)).map((t) => ({
      threadId: t.id,
      file: t.file,
      side: t.side,
      range: t.range,
      body: t.messages.map((m) => m.body).join("\n"),
    }));
  }

  private verdictEvent(s: SessionState, diff: DiffFile[]): ReviewEvent {
    return s.status === "approved"
      ? { type: "decision", verdict: "approved", comments: [] }
      : { type: "decision", verdict: "changes_requested", comments: this.openComments(s, diff) };
  }

  /** Emit a verdict; if no agent was listening, leave it briefly replayable. */
  private async deliverVerdict(c: ReviewCtx, s: SessionState): Promise<void> {
    // Only changes_requested carries comments, so only it needs the diff to scope
    // them by — an approval goes out immediately rather than after a git walk.
    if (s.status !== "approved" && c.lastDiff.length === 0) {
      c.lastDiff = await c.diff.diff(c.worktreeId);
    }
    if (this.events.emit(c.worktreeId, this.verdictEvent(s, c.lastDiff))) return;
    await c.store.save(markVerdictPending(s, Date.now()));
  }

  /** What this context is reviewing — persisted on the round so scope changes are visible. */
  private scopeOf(c: ReviewCtx): ReviewScope {
    return { stagedOnly: c.stagedOnly, baseRef: c.baseRef };
  }

  /** Recompute the diff and open a fresh review round (collapsing unchanged viewed files). */
  private async newRound(c: ReviewCtx): Promise<SessionState> {
    // A new round is a new conversation. Loaders left spinning from the last one
    // claim the agent is answering questions it has already moved on from.
    this.pending.clear();
    const prev = await c.store.load(c.worktreeId);
    c.lastDiff = await c.diff.diff(c.worktreeId);
    const s = startRound(prev, c.worktreeId, c.lastDiff, this.scopeOf(c));
    await c.store.save(s);
    return s;
  }

  /** Apply an agent push: append replies/comments, clear pending loaders, persist, re-render. */
  private async handlePush(c: ReviewCtx, push: PushPayload): Promise<void> {
    const cur = await c.store.load(c.worktreeId);
    if (!cur) {
      // Nothing to deliver into: no round was ever opened for this worktree. Say so
      // rather than leaving the agent blocked on a review that does not exist.
      this.events.emit(c.worktreeId, { type: "closed" });
      return;
    }
    let n = this.maxId(cur.threads);
    const next = applyPush(cur, push, () => `t${++n}`);
    for (const r of push.replies) this.pending.delete(r.threadId);
    await c.store.save(next);
    if (cur.interrupted) {
      // The human closed the form before this landed. The replies are saved, but the
      // review is not live — tell the agent instead of parking it on a dead round.
      this.events.emit(c.worktreeId, { type: "closed" });
      return;
    }
    // A push can be the first call on a fresh context (e.g. the agent flipped
    // --staged-only mid-round), and rendering that cache empty would blank the form.
    if (c.lastDiff.length === 0) c.lastDiff = await c.diff.diff(c.worktreeId);
    // An agent push during an OPEN review must (re)show the form — the human may
    // have closed or reloaded the window (e.g. mid-Clarify). A decided session
    // (approved/changes_requested) stays closed: onState only re-renders if open.
    if (next.status === "open") {
      this.onFormOpened(next, c.lastDiff);
      return;
    }
    // The round is already decided and its form is gone — this is the agent pushing
    // the replies that document its fixes, exactly as the loop prescribes. Nothing
    // downstream will ever produce an event for it, so answer now: without this the
    // call parks on the poll for the whole ceiling at the moment the agent has work
    // to get on with.
    this.onStateRendered(next, c.lastDiff);
    this.events.emit(c.worktreeId, { type: "idle" });
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
    if (cur?.status !== "open" || cur.interrupted) return;
    // Walking out ends the round just as a verdict does — whatever the human asks
    // for next (re-run, commit, chat) starts from a fresh round, not this one.
    await c.store.save(markInterrupted(cur));
    this.events.emit(c.worktreeId, { type: "closed" });
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
    if (c.lastDiff.length === 0) c.lastDiff = await c.diff.diff(c.worktreeId);
    const comments = this.openComments(cur, c.lastDiff);
    // Replace rather than add: the loaders describe what the agent was just
    // handed. Adding leaves every earlier question the agent never answered
    // counted forever, so one open comment reads as three.
    this.pending.clear();
    for (const { threadId } of comments) this.pending.add(threadId);
    this.onStateRendered(cur, c.lastDiff);
    this.events.emit(c.worktreeId, { type: "decision", verdict: "clarify", comments });
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
    this.onStateRendered(next, c.lastDiff);
    // Only "Ask agent" asks for the agent's attention. A passive comment is a note
    // the human leaves mid-read: it is already saved, and it reaches the agent
    // inside the verdict. Waking the loop for it would send the agent off fixing
    // half a review before the human has decided anything.
    // Held when the agent is between calls (off writing the previous answer):
    // a question the human asked must never be silently dropped.
    if (ask) {
      this.events.emit(c.worktreeId, { type: "question", threadId, file, side, range, body }, true);
    }
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
    this.onStateRendered(next, c.lastDiff);
    // Same rule as a new thread: only Ask agent wakes the loop. A plain reply is
    // recorded and travels with the verdict.
    if (ask) {
      this.events.emit(
        c.worktreeId,
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
    const c = this.current;
    if (!c) return;
    const cur = await c.store.load(c.worktreeId);
    if (!cur) return;
    const next = editMessage(cur, threadId, index, body);
    await c.store.save(next);
    this.onStateRendered(next, c.lastDiff);
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
    // A closed thread has nothing left to wait for: the human stopped waiting
    // for the answer, so it must stop counting as one the agent owes.
    if (resolved) this.pending.delete(threadId);
    await c.store.save(next);
    this.onStateRendered(next, c.lastDiff);
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
    this.onStateRendered(next, c.lastDiff);
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
