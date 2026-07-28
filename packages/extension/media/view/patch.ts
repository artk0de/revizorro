/** One rendered row of a diff: a real line, a hunk header, or an expand control. */
export interface Line {
  kind: "add" | "del" | "ctx" | "hunk" | "expand";
  oldNo?: number;
  newNo?: number;
  text: string;
  /** For "expand" rows: which hidden context this control reveals when clicked. */
  gap?: { file: string; key: string; up?: number; down?: number };
}

/** Files whose diff is noise by default — collapsed until asked for. */
export const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock)$/;

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** git's file-level preamble, which carries no reviewable content. */
const PREAMBLE = [
  "diff --git",
  "index ",
  "--- ",
  "+++ ",
  "new file",
  "deleted file",
  "old mode",
  "new mode",
  "similarity",
  "rename ",
];

/** Turn a unified patch into rows, tracking both files' line numbers as it goes. */
export function parsePatch(patch: string): Line[] {
  const out: Line[] = [];
  let newNo = 0;
  let oldNo = 0;
  for (const raw of patch.split("\n")) {
    if (PREAMBLE.some((p) => raw.startsWith(p))) continue;
    if (raw.startsWith("@@")) {
      const m = HUNK_RE.exec(raw);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) out.push({ kind: "add", newNo: newNo++, text: raw.slice(1) });
    else if (raw.startsWith("-")) out.push({ kind: "del", oldNo: oldNo++, text: raw.slice(1) });
    else out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
  }
  return out;
}

/** Added/removed line counts, for the tree's +N −M column and the toolbar total. */
export function diffStat(patch: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

/** How many lines each expand control reveals per click. */
export const EXPAND_STEP = 20;

/**
 * Splice the file's hidden context into the gaps between hunks, gated by how much
 * of each gap has been revealed so far. Revealed lines are plain context, so they
 * render — and accept comments — like any other line.
 */
export function withExpansions(
  file: { path: string; content: string },
  lines: Line[],
  revealedByGap: Map<string, number>,
): Line[] {
  if (!file.content) return lines;
  const contentLines = file.content.split("\n");
  if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") contentLines.pop();
  const total = contentLines.length;
  const out: Line[] = [];

  const ctxLine = (n: number, offset: number): Line => ({
    kind: "ctx",
    newNo: n,
    oldNo: n - offset,
    text: contentLines[n - 1] ?? "",
  });
  // grow="up": reveal from the bottom edge (nearest the following hunk) upward;
  // grow="down": reveal from the top edge (nearest the preceding hunk) downward.
  const emitGap = (
    startNew: number,
    endNew: number,
    offset: number,
    id: string,
    grow: "up" | "down",
  ): void => {
    const size = endNew - startNew + 1;
    if (size <= 0) return;
    const key = `${file.path}#${id}`;
    const revealed = Math.min(size, revealedByGap.get(key) ?? 0);
    const hidden = size - revealed;
    const control = (): Line => ({ kind: "expand", text: "", gap: { file: file.path, key, up: hidden } });
    if (grow === "up") {
      if (hidden > 0) out.push(control());
      for (let n = endNew - revealed + 1; n <= endNew; n++) out.push(ctxLine(n, offset));
    } else {
      for (let n = startNew; n < startNew + revealed; n++) out.push(ctxLine(n, offset));
      if (hidden > 0) out.push(control());
    }
  };

  let lastNew = 0;
  let lastOld = 0;
  let firstHunk = true;
  let gapIdx = 0;
  for (const l of lines) {
    if (l.kind === "hunk") {
      const m = HUNK_RE.exec(l.text);
      if (m) {
        const offset = parseInt(m[2], 10) - parseInt(m[1], 10);
        if (firstHunk) emitGap(1, parseInt(m[2], 10) - 1, offset, "top", "up");
        else emitGap(lastNew + 1, parseInt(m[2], 10) - 1, offset, `g${gapIdx++}`, "down");
        firstHunk = false;
      }
      out.push(l);
      continue;
    }
    out.push(l);
    if (l.newNo !== undefined) lastNew = l.newNo;
    if (l.oldNo !== undefined) lastOld = l.oldNo;
  }
  if (lastNew > 0) emitGap(lastNew + 1, total, lastNew - lastOld, "bottom", "down");
  return out;
}
