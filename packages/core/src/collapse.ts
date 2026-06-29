import type { FileViewState } from "@revizorro/protocol";

export interface DiffFile {
  path: string;
  contentHash: string;
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
