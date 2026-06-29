import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { HttpReviewHost, FsSessionStore, GitDiffProvider } from "@revizorro/core-adapters";
import { startRound, applyPush, applyDecision } from "@revizorro/core";
import type { SessionState, FileRange } from "@revizorro/protocol";

/**
 * Long-lived review session host. Owns the HTTP event broker, the persisted
 * session, and the diff provider. The form (VS Code UI) calls the emit* methods
 * when the human acts; each emit unblocks one waiting CLI `review` call.
 */
export class ReviewHost {
  readonly events = new HttpReviewHost();
  private store: FsSessionStore;
  private diff: GitDiffProvider;
  private idN = 0;

  constructor(
    private readonly repoRoot: string,
    private readonly worktreeId: string,
    private readonly onState: (s: SessionState) => void,
    baseRef = "main",
  ) {
    this.store = new FsSessionStore(repoRoot);
    this.diff = new GitDiffProvider(repoRoot, baseRef);
    this.events.onPush(async (_wt, push) => {
      const cur = await this.store.load(this.worktreeId);
      if (!cur) return;
      const next = applyPush(cur, push, () => `a${++this.idN}`);
      await this.store.save(next);
      this.onState(next);
    });
  }

  async start(): Promise<void> {
    const port = await this.events.start();
    const p = join(this.repoRoot, ".claude", "revizorro", "port");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(port), "utf8");
    await this.newRound();
  }

  /** Recompute the diff and open a fresh review round (collapsing unchanged viewed files). */
  async newRound(): Promise<SessionState> {
    const prev = await this.store.load(this.worktreeId);
    const files = await this.diff.diff(this.worktreeId);
    const s = startRound(prev, this.worktreeId, files);
    await this.store.save(s);
    this.onState(s);
    return s;
  }

  approve(): void {
    void this.finalize("approved");
    this.events.emit(this.worktreeId, { type: "decision", verdict: "approved", comments: [] });
  }

  async decline(): Promise<void> {
    const s = await this.finalize("declined");
    const comments = s.threads.map((t) => ({
      threadId: t.id,
      file: t.file,
      range: t.range,
      body: t.messages.map((m) => m.body).join("\n"),
    }));
    this.events.emit(this.worktreeId, { type: "decision", verdict: "declined", comments });
  }

  /** Human leaves a comment that the agent should address now. */
  emitComment(threadId: string, file: string, range: FileRange, body: string): void {
    this.events.emit(this.worktreeId, { type: "comment", threadId, file, range, body });
  }

  /** Human asks the agent to reply to a thread in realtime (form stays open). */
  emitQuestion(threadId: string, file: string, range: FileRange, body: string): void {
    this.events.emit(this.worktreeId, { type: "question", threadId, file, range, body });
  }

  stop(): Promise<void> {
    return this.events.stop();
  }

  private async finalize(verdict: "approved" | "declined"): Promise<SessionState> {
    const cur = (await this.store.load(this.worktreeId)) ?? (await this.newRound());
    const next = applyDecision(cur, verdict);
    await this.store.save(next);
    this.onState(next);
    return next;
  }
}
