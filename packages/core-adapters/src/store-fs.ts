import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { SessionState } from "@revizorro/protocol";
import type { SessionStore } from "@revizorro/core";

export class FsSessionStore implements SessionStore {
  constructor(private readonly repoRoot: string) {}

  private path(worktreeId: string): string {
    return join(this.repoRoot, ".claude", "revizorro", worktreeId, "session.json");
  }

  async load(worktreeId: string): Promise<SessionState | null> {
    try {
      const raw = await readFile(this.path(worktreeId), "utf8");
      return SessionState.parse(JSON.parse(raw));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async save(s: SessionState): Promise<void> {
    const p = this.path(s.worktreeId);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
    await rename(tmp, p);
  }
}
