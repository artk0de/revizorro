import type { FileViewState } from "@revizorro/protocol";

export interface DiffFile {
  path: string;
  contentHash: string;
  /** Raw unified `git diff` body for the file (worktree vs merge-base). Transient — not persisted. */
  patch?: string;
  /** Current (worktree) text of the file, for expanding diff context. Absent for binary/deleted files. */
  content?: string;
  /** True when git reports the file as binary (no textual diff). */
  binary?: boolean;
}

export function decideCollapsed(
  prev: Record<string, FileViewState>,
  current: DiffFile[],
): { collapsed: string[]; files: Record<string, FileViewState> } {
  const collapsed: string[] = [];
  const files: Record<string, FileViewState> = {};
  for (const f of current) {
    const before = prev[f.path];
    const unchanged = before?.viewed === true && before.contentHash === f.contentHash;
    files[f.path] = { viewed: unchanged, contentHash: f.contentHash };
    if (unchanged) collapsed.push(f.path);
  }
  return { collapsed, files };
}
