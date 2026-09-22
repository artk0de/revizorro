import { FsSessionStore, GitDiffProvider } from "@revizorro/core-adapters";
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
  threadsInDiff,
  editMessage as editThreadMessage,
  type DiffFile,
} from "@revizorro/core";
import type {
  SessionState,
  FileRange,
  PushPayload,
  ReviewEvent,
  ReviewScope,
  Side,
} from "@revizorro/protocol";

import type { ReviewActions } from "./panel.js";

/** What the form shows at a glance, read synchronously when a poll times out. */
export interface ReviewSnapshot {
  round: number;
  files: number;
  openThreads: number;
  viewedFiles: number;
}

/**
 * What one review needs from the window around it: a way to reach the agent, and a
 * way to put state on screen. Injected rather than reached for, so a session can be
 * driven in a test without a webview, and so two sessions in one window cannot
 * accidentally share the state that used to live beside them.
 */
export interface ReviewSessionDeps {
  /** Hand an event to the agent. False when nobody was listening. */
  emit: (worktreeId: string, event: ReviewEvent, holdIfIdle?: boolean) => boolean;
  /** Whether an agent is blocked on THIS review right now — the form says so. */
  isAgentWaiting: (worktreeId: string) => boolean;
  /** The human is at this review's form; keeps its inactivity clock honest. */
  noteActivity: (worktreeId: string) => void;
  renderState: (session: ReviewSession, s: SessionState, diff: DiffFile[]) => void;
  openForm: (session: ReviewSession, s: SessionState, diff: DiffFile[]) => void;
}

/** Everything a review of one worktree is, at one scope: its identity and its state. */
export interface ReviewIdentity {
  repoRoot: string;
  worktreeId: string;
  /** The CLI asked to review the index only — unstaged edits stay out of the diff. */
  stagedOnly: boolean;
  /** Branch under review. Part of the session key, so a checkout starts fresh. */
  branch: string;
  /** Target branch the CLI asked to review against ("" = auto-detect). */
  baseRef: string;
}

/**
 * One review: one worktree, at one scope, on one branch. Owns everything that used
 * to sit as a singleton field on the host — the diff cache, the threads the agent
 * owes an answer to, what the form is showing, when the round opened — so a second
 * review in the same window has its own copy of all of it rather than overwriting
 * this one's.
 */
export class ReviewSession implements ReviewActions {
  readonly repoRoot: string;
  readonly worktreeId: string;
  readonly stagedOnly: boolean;
  readonly baseRef: string;
  private readonly branchName: string;
  private readonly store: FsSessionStore;
  private readonly diffs: GitDiffProvider;
  private lastDiff: DiffFile[] = [];
  /** Thread ids awaiting an agent reply (Ask agent) — drives the form's loader. */
  private readonly pending = new Set<string>();
  /** Last rendered state, summarised for the idle event (read synchronously). */
  private lastSnapshot?: ReviewSnapshot;
  /** When the round on screen opened, read synchronously when an event goes out. */
  private openedAt?: number;

  constructor(
    identity: ReviewIdentity,
    private readonly deps: ReviewSessionDeps,
  ) {
    this.repoRoot = identity.repoRoot;
    this.worktreeId = identity.worktreeId;
    this.stagedOnly = identity.stagedOnly;
    this.branchName = identity.branch;
    this.baseRef = identity.baseRef;
    this.store = new FsSessionStore(identity.repoRoot, identity.branch);
    // The diff source is baked into the provider, so a different scope is a
    // different session rather than a mutation of this one.
    this.diffs = new GitDiffProvider(identity.repoRoot, identity.baseRef || undefined, {
      stagedOnly: identity.stagedOnly,
    });
  }

  /**
   * Whether this session is already reviewing what a call is asking for. A different
   * scope or branch is a different review, and gets its own session.
   */
  matches(repoRoot: string, scope: ReviewScope, branch: string): boolean {
    return (
      this.repoRoot === repoRoot &&
      this.stagedOnly === scope.stagedOnly &&
      this.baseRef === scope.baseRef &&
      this.branchName === branch
    );
  }

  /** Branch under review, for this tab's toolbar. */
  branch(): string {
    return this.branchName;
  }

  isPending(threadId: string): boolean {
    return this.pending.has(threadId);
  }

  /** Whether an agent is blocked on this review right now. */
  isAgentWaiting(): boolean {
    return this.deps.isAgentWaiting(this.worktreeId);
  }

  /**
   * This review's form saw human input. Reading, expanding context and marking a
   * file viewed emit no event, so without this a careful reader is
   * indistinguishable from an empty desk.
   */
  noteActivity(): void {
    this.deps.noteActivity(this.worktreeId);
  }

  snapshot(): ReviewSnapshot | undefined {
    return this.lastSnapshot;
  }

  roundOpenedAt(): number | undefined {
    return this.openedAt;
  }

  /** What this session is reviewing — persisted on the round so scope changes are visible. */
  scope(): ReviewScope {
    return { stagedOnly: this.stagedOnly, baseRef: this.baseRef };
  }

  /** Open the form for a `review` call: re-render the open round, or start a fresh one. */
  async openForReview(): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    // Continue the open round only when it is showing the SAME review. Asking for
    // the staged change while a whole-branch round is open (or vice versa) is a new
    // review and gets its own round — otherwise the form keeps the old scope.
    if (cur?.status === "open" && !cur.interrupted && !scopeChanged(cur, this.scope())) {
      // Always re-read the diff: the agent calls review again precisely because the
      // tree moved on (fixes applied, files staged, work committed).
      this.lastDiff = await this.diffs.diff(this.worktreeId);
      // And re-earn the ticks. A viewed mark says "I have read this diff"; once the
      // agent rewrites the file, the human has not read what is now on screen, and a
      // tick left standing invites them to approve code nobody looked at. Continuing
      // a round has to reconcile the marks the same way starting one does.
      const { files } = decideCollapsed(cur.files, this.lastDiff);
      const reconciled = { ...cur, files };
      await this.store.save(reconciled);
      this.onFormOpened(reconciled);
      return;
    }
    // A verdict decided moments ago that never reached an agent — the human hit
    // approve while the CLI was still starting its poll. Hand it over now. Past the
    // replay window this is a request for the NEXT round, not a question about the
    // last one, so a stale approval must not be served here.
    if (cur && isVerdictReplayable(cur, Date.now())) {
      await this.store.save(markVerdictDelivered(cur));
      if (this.lastDiff.length === 0) this.lastDiff = await this.diffs.diff(this.worktreeId);
      this.deps.emit(this.worktreeId, this.verdictEvent(cur));
      return;
    }
    this.onFormOpened(await this.newRound());
  }

  /**
   * Bring this review back up after a window reload, reconciling it against the tree
   * as it stands now. Returns false when there is nothing to restore — a decided or
   * abandoned round must not pop back up every time a window restarts.
   */
  async restore(): Promise<boolean> {
    const s = await this.store.load(this.worktreeId);
    if (s?.status !== "open" || s.interrupted) return false;
    this.lastDiff = await this.diffs.diff(this.worktreeId);
    // The tree may well have moved while the window was down, so ticks are re-earned
    // the same way any other re-read of the diff earns them.
    const { files } = decideCollapsed(s.files, this.lastDiff);
    const reconciled = { ...s, files };
    await this.store.save(reconciled);
    this.onFormOpened(reconciled);
    return true;
  }

  /**
   * Repaint the round if it is still live. The form shows whether an agent is
   * listening, and that changes between calls. A decided or abandoned round is not on
   * screen, and this fires on the first packet of the NEXT call — which, after a
   * checkout, would flash the previous branch's finished review.
   */
  async rerenderIfOpen(): Promise<void> {
    const s = await this.store.load(this.worktreeId);
    if (s?.status === "open" && !s.interrupted) this.onStateRendered(s);
  }

  /** Apply an agent push: append replies/comments, clear pending loaders, persist, re-render. */
  async handlePush(push: PushPayload): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur) {
      // Nothing to deliver into: no round was ever opened for this worktree. Say so
      // rather than leaving the agent blocked on a review that does not exist.
      this.deps.emit(this.worktreeId, { type: "closed" });
      return;
    }
    let n = this.maxId(cur.threads);
    const next = applyPush(cur, push, () => `t${++n}`);
    for (const r of push.replies) this.pending.delete(r.threadId);
    await this.store.save(next);
    if (cur.interrupted) {
      // The human closed the form before this landed. The replies are saved, but the
      // review is not live — tell the agent instead of parking it on a dead round.
      this.deps.emit(this.worktreeId, { type: "closed" });
      return;
    }
    // A push can be the first call on a fresh session (e.g. the agent flipped
    // --staged-only mid-round), and rendering that cache empty would blank the form.
    if (this.lastDiff.length === 0) this.lastDiff = await this.diffs.diff(this.worktreeId);
    // An agent push during an OPEN review must (re)show the form — the human may
    // have closed or reloaded the window (e.g. mid-Clarify). A decided session
    // (approved/changes_requested) stays closed: onState only re-renders if open.
    if (next.status === "open") {
      this.onFormOpened(next);
      return;
    }
    // The round is already decided and its form is gone — this is the agent pushing
    // the replies that document its fixes, exactly as the loop prescribes. Nothing
    // downstream will ever produce an event for it, so answer now: without this the
    // call parks on the poll for the whole ceiling at the moment the agent has work
    // to get on with.
    this.onStateRendered(next);
    this.deps.emit(this.worktreeId, { type: "idle" });
  }

  async approve(): Promise<void> {
    await this.deliverVerdict(await this.finalize("approved"));
  }

  /** Request changes: the agent fixes every open comment and re-submits a new round. */
  async requestChanges(): Promise<void> {
    await this.deliverVerdict(await this.finalize("changes_requested"));
  }

  /**
   * The human closed the form without a verdict. Only signal `closed` while the
   * session is still open — a decided (approved/changes_requested) session has
   * already unblocked the agent, so its late dispose must stay silent.
   */
  async abandon(): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (cur?.status !== "open" || cur.interrupted) return;
    // Walking out ends the round just as a verdict does — whatever the human asks
    // for next (re-run, commit, chat) starts from a fresh round, not this one.
    await this.store.save(markInterrupted(cur));
    this.deps.emit(this.worktreeId, { type: "closed" });
  }

  /**
   * Clarify: the agent answers every open thread (no code changes). The form stays
   * open; open threads are marked pending so the loaders show until each is answered.
   */
  async clarify(): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur) return;
    if (this.lastDiff.length === 0) this.lastDiff = await this.diffs.diff(this.worktreeId);
    const comments = this.openComments(cur);
    // Replace rather than add: the loaders describe what the agent was just
    // handed. Adding leaves every earlier question the agent never answered
    // counted forever, so one open comment reads as three.
    this.pending.clear();
    for (const { threadId } of comments) this.pending.add(threadId);
    this.onStateRendered(cur);
    this.deps.emit(this.worktreeId, { type: "decision", verdict: "clarify", comments });
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
    const cur = await this.store.load(this.worktreeId);
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
    await this.store.save(next);
    this.onStateRendered(next);
    // Only "Ask agent" asks for the agent's attention. A passive comment is a note
    // the human leaves mid-read: it is already saved, and it reaches the agent
    // inside the verdict. Waking the loop for it would send the agent off fixing
    // half a review before the human has decided anything.
    // Held when the agent is between calls (off writing the previous answer):
    // a question the human asked must never be silently dropped.
    if (ask) {
      this.deps.emit(
        this.worktreeId,
        { type: "question", threadId, file, side, range, body },
        true,
      );
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
    this.onStateRendered(next);
    // Same rule as a new thread: only Ask agent wakes the loop. A plain reply is
    // recorded and travels with the verdict.
    if (ask) {
      this.deps.emit(
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
    this.onStateRendered(next);
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
    this.onStateRendered(next);
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
    this.onStateRendered(next);
  }

  /** Highest numeric suffix across existing thread ids — so new ids never collide after a restart. */
  private maxId(threads: SessionState["threads"]): number {
    return threads.reduce((m, t) => {
      const n = parseInt(t.id.replace(/\D/g, ""), 10);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
  }

  /** Recompute the diff and open a fresh review round (collapsing unchanged viewed files). */
  private async newRound(): Promise<SessionState> {
    // A new round is a new conversation. Loaders left spinning from the last one
    // claim the agent is answering questions it has already moved on from.
    this.pending.clear();
    const prev = await this.store.load(this.worktreeId);
    this.lastDiff = await this.diffs.diff(this.worktreeId);
    const s = startRound(prev, this.worktreeId, this.lastDiff, this.scope(), Date.now());
    await this.store.save(s);
    return s;
  }

  /**
   * Open threads handed to the agent alongside a verdict (or a clarify request) —
   * only those on files in the diff under review. The session keeps threads from
   * earlier rounds and other scopes, and shipping all of them would tell the agent
   * to go fix work that shipped days ago.
   */
  private openComments(s: SessionState): {
    threadId: string;
    file: string;
    side: Side;
    range: FileRange;
    body: string;
  }[] {
    return threadsInDiff(
      s,
      this.lastDiff.map((f) => f.path),
    ).map((t) => ({
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
  private async deliverVerdict(s: SessionState): Promise<void> {
    // Only changes_requested carries comments, so only it needs the diff to scope
    // them by — an approval goes out immediately rather than after a git walk.
    if (s.status !== "approved" && this.lastDiff.length === 0) {
      this.lastDiff = await this.diffs.diff(this.worktreeId);
    }
    if (this.deps.emit(this.worktreeId, this.verdictEvent(s))) return;
    await this.store.save(markVerdictPending(s, Date.now()));
  }

  private async finalize(verdict: "approved" | "changes_requested"): Promise<SessionState> {
    const cur = (await this.store.load(this.worktreeId)) ?? (await this.newRound());
    // Persisted as delivered up front: the agent re-reads the session as soon as the
    // event lands, and must never find a verdict that still looks pending — that
    // would replay it a second time. deliverVerdict undoes this if nobody listened.
    const next = markVerdictDelivered(applyDecision(cur, verdict));
    await this.store.save(next);
    return next;
  }

  /** Render into the open form, remembering what it shows for the idle snapshot. */
  private onStateRendered(s: SessionState): void {
    this.remember(s);
    this.deps.renderState(this, s, this.lastDiff);
  }

  /** Open (or re-open) the form, remembering what it shows for the idle snapshot. */
  private onFormOpened(s: SessionState): void {
    this.remember(s);
    this.deps.openForm(this, s, this.lastDiff);
  }

  private remember(s: SessionState): void {
    this.openedAt = s.openedAt;
    const paths = new Set(this.lastDiff.map((f) => f.path));
    this.lastSnapshot = {
      round: s.round,
      files: this.lastDiff.length,
      openThreads: s.threads.filter((t) => !t.resolved && paths.has(t.file)).length,
      viewedFiles: this.lastDiff.filter((f) => s.files[f.path]?.viewed).length,
    };
  }
}
