import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { SessionState } from "@revizorro/protocol";
import type { SessionStore } from "@revizorro/core";

export class FsSessionStore implements SessionStore {
  /** Distinguishes concurrent writes within this process. */
  private static writes = 0;

  /**
   * A review belongs to the branch it reviews, so the branch is part of the key.
   * Sharing one file across branches carries the round number, the threads and the
   * viewed marks through a checkout — and lets a verdict decided on one branch be
   * replayed into the review of another.
   */
  constructor(
    private readonly repoRoot: string,
    private readonly branch = "",
  ) {}

  /** Hashed, because branch names carry slashes and would nest directories. */
  private branchKey(): string {
    if (!this.branch) return "_";
    return createHash("sha1").update(this.branch).digest("hex").slice(0, 12);
  }

  private path(worktreeId: string): string {
    return join(this.repoRoot, ".claude", "revizorro", worktreeId, this.branchKey(), "session.json");
  }

  async load(worktreeId: string): Promise<SessionState | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(worktreeId), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    // A session written by an older/incompatible schema (or corrupt JSON) must
    // not crash the form — treat it as absent and start a fresh round.
    try {
      const parsed = SessionState.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async save(s: SessionState): Promise<void> {
    const p = this.path(s.worktreeId);
    await mkdir(dirname(p), { recursive: true });
    // Saves overlap — an agent push can land while the human posts a comment — so
    // each writer needs its own temp file. A shared one made the slower writer fail
    // on rename after the faster one had already moved it away.
    const tmp = `${p}.${process.pid}.${(FsSessionStore.writes += 1)}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
    await rename(tmp, p);
  }
}
