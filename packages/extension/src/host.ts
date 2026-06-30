import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { HttpReviewHost, FsSessionStore, GitDiffProvider } from "@revizorro/core-adapters";
import { startRound, applyPush, applyDecision, type DiffFile } from "@revizorro/core";
import type { SessionState, FileRange, PushPayload } from "@revizorro/protocol";

/**
 * Long-lived review session host. Owns the HTTP event broker, the persisted
 * session, and the diff provider. The form (VS Code UI) calls the emit* methods
 * when the human acts; each emit unblocks one waiting CLI `review` call.
 */
export class ReviewHost {
  readonly events = new HttpReviewHost();
  private readonly store: FsSessionStore;
  private readonly diff: GitDiffProvider;
  private lastDiff: DiffFile[] = [];
  /** Thread ids awaiting an agent reply (Ask agent) — drives the form's loader. */
  private readonly pending = new Set<string>();

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

  constructor(
    private readonly repoRoot: string,
    private readonly worktreeId: string,
    private readonly onState: (s: SessionState, diff: DiffFile[]) => void,
    baseRef = "main",
  ) {
    this.store = new FsSessionStore(repoRoot);
    this.diff = new GitDiffProvider(repoRoot, baseRef);
    this.events.onPush((_wt, push) => {
      void this.handlePush(push);
    });
    // Open the form whenever the agent connects with `review` — this is when the
    // form appears, not on activation/reload.
    this.events.onReview(() => {
      void this.openForReview();
    });
  }

  /** Open the form for a `review` call: re-render the open round, or start a fresh one. */
  private async openForReview(): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (cur?.status === "open") {
      if (this.lastDiff.length === 0) this.lastDiff = await this.diff.diff(this.worktreeId);
      this.onState(cur, this.lastDiff);
    } else {
      await this.newRound();
    }
  }

  /** Apply an agent push: append replies/comments, clear pending loaders, persist, re-render. */
  private async handlePush(push: PushPayload): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur) return;
    let n = this.maxId(cur.threads);
    const next = applyPush(cur, push, () => `t${++n}`);
    for (const r of push.replies) this.pending.delete(r.threadId);
    await this.store.save(next);
    this.onState(next, this.lastDiff);
  }

  async start(): Promise<void> {
    const port = await this.events.start();
    const p = join(this.repoRoot, ".claude", "revizorro", "port");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(port), "utf8");
    // Don't open the form on activation — only when the agent runs `review`.
  }

  /** Recompute the diff and open a fresh review round (collapsing unchanged viewed files). */
  async newRound(): Promise<SessionState> {
    const prev = await this.store.load(this.worktreeId);
    this.lastDiff = await this.diff.diff(this.worktreeId);
    const s = startRound(prev, this.worktreeId, this.lastDiff);
    await this.store.save(s);
    this.onState(s, this.lastDiff);
    return s;
  }

  approve(): void {
    void this.finalize("approved");
    this.events.emit(this.worktreeId, { type: "decision", verdict: "approved", comments: [] });
  }

  /** Request changes: the agent fixes every open comment and re-submits a new round. */
  async requestChanges(): Promise<void> {
    const s = await this.finalize("changes_requested");
    const comments = s.threads
      .filter((t) => !t.resolved)
      .map((t) => ({
        threadId: t.id,
        file: t.file,
        range: t.range,
        body: t.messages.map((m) => m.body).join("\n"),
      }));
    this.events.emit(this.worktreeId, { type: "decision", verdict: "changes_requested", comments });
  }

  /**
   * Clarify: the agent answers every open thread (no code changes). The form
   * stays open; open threads are marked pending so the loaders show until each
   * is answered.
   */
  async clarify(): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur) return;
    const open = cur.threads.filter((t) => !t.resolved);
    for (const t of open) this.pending.add(t.id);
    this.onState(cur, this.lastDiff);
    const comments = open.map((t) => ({
      threadId: t.id,
      file: t.file,
      range: t.range,
      body: t.messages.map((m) => m.body).join("\n"),
    }));
    this.events.emit(this.worktreeId, { type: "decision", verdict: "clarify", comments });
  }

  /**
   * Human opens a new thread on a line. `ask=true` wakes the agent for an
   * immediate reply (question event); otherwise it is a passive comment.
   */
  async addHumanComment(file: string, range: FileRange, body: string, ask = false): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur) return;
    const threadId = `t${this.maxId(cur.threads) + 1}`;
    const next: SessionState = {
      ...cur,
      threads: [
        ...cur.threads,
        { id: threadId, file, range, messages: [{ author: "human", body }], resolved: false },
      ],
    };
    if (ask) this.pending.add(threadId);
    await this.store.save(next);
    this.onState(next, this.lastDiff);
    this.events.emit(this.worktreeId, {
      type: ask ? "question" : "comment",
      threadId,
      file,
      range,
      body,
    });
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
    this.onState(next, this.lastDiff);
    this.events.emit(this.worktreeId, {
      type: ask ? "question" : "comment",
      threadId,
      file: thread.file,
      range: thread.range,
      body,
    });
  }

  /** Mark a thread resolved/unresolved; persist and re-render. Resolved threads drop from the next round. */
  async resolveThread(threadId: string, resolved: boolean): Promise<void> {
    const cur = await this.store.load(this.worktreeId);
    if (!cur) return;
    const next: SessionState = {
      ...cur,
      threads: cur.threads.map((t) => (t.id === threadId ? { ...t, resolved } : t)),
    };
    await this.store.save(next);
    this.onState(next, this.lastDiff);
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
    this.onState(next, this.lastDiff);
  }

  async stop(): Promise<void> {
    return this.events.stop();
  }

  private async finalize(verdict: "approved" | "changes_requested"): Promise<SessionState> {
    const cur = (await this.store.load(this.worktreeId)) ?? (await this.newRound());
    const next = applyDecision(cur, verdict);
    await this.store.save(next);
    return next;
  }
}
