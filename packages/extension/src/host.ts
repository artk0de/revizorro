import {
  HttpReviewHost,
  FsSessionStore,
  GitDiffProvider,
  worktreeIdFor,
} from "@revizorro/core-adapters";
import { resolveScope, type DiffFile, type ReviewOptions } from "@revizorro/core";
import type { SessionState, ReviewScope } from "@revizorro/protocol";

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
  /**
   * Every review this window is running, by worktree. A map rather than one slot
   * because two agent sessions on two worktrees is the normal shape of the work: with
   * a single slot the second one evicted the first and left its agent blocked on a
   * round nobody could answer.
   */
  private readonly sessions = new Map<string, ReviewSession>();
  private readonly sessionDeps: ReviewSessionDeps;

  constructor(
    private readonly renderState: (
      session: ReviewSession,
      s: SessionState,
      diff: DiffFile[],
    ) => void,
    private readonly openForm: (session: ReviewSession, s: SessionState, diff: DiffFile[]) => void,
  ) {
    this.sessionDeps = {
      emit: (wt, event, holdIfIdle) => this.events.emit(wt, event, holdIfIdle),
      isAgentWaiting: (wt) => this.events.isWaiting(wt),
      noteActivity: (wt) => {
        this.events.noteActivity(wt);
      },
      renderState: (session, s, diff) => {
        this.renderState(session, s, diff);
      },
      openForm: (session, s, diff) => {
        this.openForm(session, s, diff);
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

  /**
   * The review running for a worktree, if any. Everything the human can do belongs to
   * ONE review, so it is asked for by worktree rather than offered as "the current
   * one" — a window with two reviews open has no current one.
   */
  review(worktreeId: string): ReviewSession | undefined {
    return this.sessions.get(worktreeId);
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

  /**
   * Get (or build) the session for a review. Keyed by worktree, so a call about one
   * worktree can never replace another's review; within a worktree, a different scope
   * or branch IS a different review and takes that worktree's slot.
   */
  private sessionOf(
    repoRoot: string,
    worktreeId: string,
    scope: ReviewScope,
    branch: string,
  ): ReviewSession {
    const cur = this.sessions.get(worktreeId);
    if (cur?.matches(repoRoot, scope, branch)) return cur;
    const session = new ReviewSession(
      {
        repoRoot,
        worktreeId,
        stagedOnly: scope.stagedOnly,
        baseRef: scope.baseRef,
        branch,
      },
      this.sessionDeps,
    );
    this.sessions.set(worktreeId, session);
    return session;
  }

  /** The session a broker callback is about. */
  private sessionFor(worktreeId: string): ReviewSession | undefined {
    return this.sessions.get(worktreeId);
  }
}
