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
    const tmp = `${p}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
    await rename(tmp, p);
  }
}
