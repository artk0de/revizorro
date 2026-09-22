import {
  HttpReviewHost,
  FsSessionStore,
  GitDiffProvider,
  worktreeIdFor,
} from "@revizorro/core-adapters";
import { resolveScope, type DiffFile, type ReviewOptions } from "@revizorro/core";
import type { SessionState, FileRange, ReviewScope, Side } from "@revizorro/protocol";

import { ReviewSession, type ReviewSessionDeps } from "./session.js";

/**
 * Review session host. Owns the HTTP event broker and the reviews running behind it;
 * each review is a ReviewSession keyed by the worktree the CLI sends, so a single VS
 * Code window can review ANY project's worktree — not only the one it happens to
 * have open. The form calls the emit* methods when the human acts; each emit unblocks
 * one waiting CLI.
 */
export class ReviewHost {
  readonly events = new HttpReviewHost();
  /** The review currently shown in the form (the last repoRoot a CLI asked for). */
  private session?: ReviewSession;
  private readonly sessionDeps: ReviewSessionDeps;

  constructor(
    private readonly renderState: (s: SessionState, diff: DiffFile[]) => void,
    private readonly openForm: (s: SessionState, diff: DiffFile[]) => void,
  ) {
    this.sessionDeps = {
      emit: (wt, event, holdIfIdle) => this.events.emit(wt, event, holdIfIdle),
      renderState: (_session, s, diff) => {
        this.renderState(s, diff);
      },
      openForm: (_session, s, diff) => {
        this.openForm(s, diff);
      },
    };
    this.events.onPush((wt, repoRoot, push, opts) => {
      void this.withSession(repoRoot, wt, opts, (session) => session.handlePush(push));
    });
    // The form appears when the agent runs `review` — not on activation/reload.
    this.events.onReview((wt, repoRoot, opts) => {
      void this.withSession(repoRoot, wt, opts, (session) => session.openForReview());
    });
    // A timed-out poll answers with a snapshot of the live review, so the agent can
    // see the round is open and simply re-arm instead of diagnosing a healthy form.
    this.events.onIdle((wt) => {
      const review = this.sessionFor(wt)?.snapshot();
      return { type: "idle", ...(review ? { review } : {}) };
    });
    // Every event carries how long the round has been going, so the agent reports a
    // duration it was told instead of adding up how long each poll happened to block.
    this.events.onRoundOpenedAt((wt) => this.sessionFor(wt)?.roundOpenedAt());
    // A long review outlives the CLI call that opened it. Re-render when an agent
    // starts or stops listening so the form can say which.
    this.events.onWaitingChanged((wt) => {
      void this.sessionFor(wt)?.rerenderIfOpen();
    });
  }

  /** Start the HTTP broker and return its port (the extension registers it globally). */
  async start(): Promise<number> {
    return this.events.start();
  }

  async stop(): Promise<void> {
    return this.events.stop();
  }

  isPending(threadId: string): boolean {
    return this.session?.isPending(threadId) ?? false;
  }

  /** Branch under review, for the form's toolbar. Empty until a round has opened. */
  branch(): string {
    return this.session?.branch ?? "";
  }

  /** Whether an agent is blocked on the active review right now. */
  isAgentWaiting(): boolean {
    return this.session ? this.events.isWaiting(this.session.worktreeId) : false;
  }

  /**
   * The form saw human input. Forwarded to the broker so a long, quiet read does
   * not read as an abandoned review. No open round means nothing to keep alive.
   */
  noteActivity(): void {
    if (this.session) this.events.noteActivity(this.session.worktreeId);
  }

  async approve(): Promise<void> {
    await this.session?.approve();
  }

  /** Request changes: the agent fixes every open comment and re-submits a new round. */
  async requestChanges(): Promise<void> {
    await this.session?.requestChanges();
  }

  /**
   * Clarify: the agent answers every open thread (no code changes). The form stays
   * open; open threads are marked pending so the loaders show until each is answered.
   */
  async clarify(): Promise<void> {
    await this.session?.clarify();
  }

  /** The human closed the form without a verdict — wake any blocked agent. */
  async abandon(): Promise<void> {
    await this.session?.abandon();
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
    await this.session?.addHumanComment(file, range, body, ask, side);
  }

  /** Human replies inside an existing thread. `ask=true` wakes the agent now. */
  async addHumanReply(threadId: string, body: string, ask = false): Promise<void> {
    await this.session?.addHumanReply(threadId, body, ask);
  }

  /** Edit one of the human's own messages in a thread; persist and re-render. */
  async editMessage(threadId: string, index: number, body: string): Promise<void> {
    await this.session?.editMessage(threadId, index, body);
  }

  /** Mark a thread resolved/unresolved; persist and re-render. Resolved threads drop from the next round. */
  async resolveThread(threadId: string, resolved: boolean): Promise<void> {
    await this.session?.resolveThread(threadId, resolved);
  }

  /** Human marks/unmarks a file as viewed; persist and re-render (no event). */
  async setViewed(file: string, viewed: boolean): Promise<void> {
    await this.session?.setViewed(file, viewed);
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
    // Checked before a session exists: building one for a finished round would take
    // the form away from whatever review is actually live.
    if (s?.status !== "open" || s.interrupted) return;
    // Reviewing whatever the round was already scoped to — a reload is not a new
    // request, so it must not silently widen a staged-only review to the branch.
    await this.sessionOf(repoRoot, worktreeId, resolveScope(s, {}), branch).restore();
  }

  /**
   * Resolve the scope against the open round before handing over the session: a call
   * that names no scope keeps reviewing whatever the round is already showing.
   */
  private async withSession(
    repoRoot: string,
    worktreeId: string,
    opts: ReviewOptions,
    run: (session: ReviewSession) => Promise<void>,
  ): Promise<void> {
    // Read the branch first: it keys the session, so loading before we know it would
    // look in the previous branch's drawer.
    const branch = await new GitDiffProvider(repoRoot).branch();
    const open = await new FsSessionStore(repoRoot, branch).load(worktreeId);
    const scope = resolveScope(open, {
      ...(opts.stagedOnly === undefined ? {} : { stagedOnly: opts.stagedOnly }),
      ...(opts.baseRef === undefined ? {} : { baseRef: opts.baseRef }),
    });
    await run(this.sessionOf(repoRoot, worktreeId, scope, branch));
  }

  /** Get (or build) the session for a review, making it the active one. */
  private sessionOf(
    repoRoot: string,
    worktreeId: string,
    scope: ReviewScope,
    branch: string,
  ): ReviewSession {
    const cur = this.session;
    if (cur?.matches(repoRoot, scope, branch)) return cur;
    this.session = new ReviewSession(
      {
        repoRoot,
        worktreeId,
        stagedOnly: scope.stagedOnly,
        baseRef: scope.baseRef,
        branch,
      },
      this.sessionDeps,
    );
    return this.session;
  }

  /** The session a broker callback is about, when it is the one on screen. */
  private sessionFor(worktreeId: string): ReviewSession | undefined {
    return this.session?.worktreeId === worktreeId ? this.session : undefined;
  }
}
