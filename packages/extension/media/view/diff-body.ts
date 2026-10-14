import { langFor } from "./highlight.js";
import { el, codeSpan } from "./dom.js";
import { parsePatch, withExpansions, EXPAND_STEP, type Line } from "./patch.js";
import { renderThread, openCompose, type ThreadView } from "./thread.js";

/**
 * A file's diff as rendered rows — inline or side by side — with the comment
 * gutters, the line selection they read, and the expand-context controls.
 *
 * Both pieces of state here outlive a render: the selection is what a shift-click
 * extends, and revealed context must stay revealed when an agent push rebuilds
 * the form.
 */

export interface DiffFile {
  path: string;
  patch: string;
  content: string;
  threads: ThreadView[];
}

// How many lines each expand control reveals per click, and how many context
// lines already revealed per gap (keyed `${file}#${gapId}`), across re-renders.
const expandedGaps = new Map<string, number>();

let sel: { file: string; start: number; end: number } | null = null;

// Revealing context re-renders the whole form; the entry module owns render.
let rerender: () => void = () => {};

export function setRerender(fn: () => void): void {
  rerender = fn;
}

function selectLine(file: string, line: number, shift: boolean): void {
  if (shift && sel?.file === file) sel.end = line;
  else sel = { file, start: line, end: line };
  highlightSelection();
}
function selectionFor(file: string, line: number): { start: number; end: number } {
  if (sel?.file === file) {
    return { start: Math.min(sel.start, sel.end), end: Math.max(sel.start, sel.end) };
  }
  return { start: line, end: line };
}
function clearSelection(): void {
  sel = null;
  highlightSelection();
}
function highlightSelection(): void {
  document.querySelectorAll(".ln.sel, .gcode.sel").forEach((e) => {
    e.classList.remove("sel");
  });
  const cur = sel;
  if (!cur) return;
  const lo = Math.min(cur.start, cur.end);
  const hi = Math.max(cur.start, cur.end);
  document.querySelectorAll(".ln, .gcode").forEach((e) => {
    const row = e as HTMLElement;
    const ln = row.dataset.line ? parseInt(row.dataset.line, 10) : NaN;
    if (row.dataset.file === cur.file && ln >= lo && ln <= hi) row.classList.add("sel");
  });
}

function inlineBody(f: DiffFile, lines: Line[], lang: string | null): HTMLElement {
  const body = el("div");
  // Keyed by side: a removed line and an added line can share a number, and putting
  // both threads on whichever row came first anchors half of them to the wrong code.
  const byNew: Record<number, ThreadView[]> = {};
  const byOld: Record<number, ThreadView[]> = {};
  for (const t of f.threads) ((t.side === "old" ? byOld : byNew)[t.line] ||= []).push(t);
  for (const l of lines) {
    if (l.kind === "expand") {
      body.append(expandRow(l));
      continue;
    }
    if (l.kind === "hunk") {
      body.append(el("div", "ln hunk", l.text));
      continue;
    }
    const row = el("div", `ln ${l.kind}`);
    const gut = el("span", "gut");
    // A removed line has no new-side number, but "why did this go?" is a question
    // the review has to be able to ask — so it anchors to the old side instead.
    const side: "old" | "new" = l.newNo !== undefined ? "new" : "old";
    const anchor = l.newNo ?? l.oldNo;
    if (anchor !== undefined) {
      const line = anchor;
      gut.textContent = "💬";
      gut.title = `comment on ${side} line ${line}`;
      gut.classList.add("cm");
      gut.onclick = () => {
        // Multi-line selection is a new-side affordance; a removed line comments alone.
        const sel = side === "new" ? selectionFor(f.path, line) : { start: line, end: line };
        openCompose(row, f.path, sel.start, sel.end, side);
        clearSelection();
      };
    }
    const no = el(
      "span",
      "no",
      l.kind === "del" ? "" : l.newNo !== undefined ? String(l.newNo) : "",
    );
    if (l.newNo !== undefined) {
      const line = l.newNo;
      no.classList.add("pick");
      no.onclick = (e) => {
        selectLine(f.path, line, (e as MouseEvent).shiftKey);
      };
    }
    row.dataset.file = f.path;
    if (l.newNo !== undefined) row.dataset.line = String(l.newNo);
    row.append(gut, no, codeSpan(l.text, lang));
    body.append(row);
    const th =
      l.newNo !== undefined ? byNew[l.newNo] : l.oldNo !== undefined ? byOld[l.oldNo] : undefined;
    if (th) for (const t of th) body.append(renderThread(t));
  }
  return body;
}

// A split line-number cell. When the line exists it hosts a 💬 gutter that opens
// a composer anchored to THAT side's line (old = left/deleted, new = right/added).
function numCell(
  no: number | undefined,
  cls: string,
  file: string,
  side: "old" | "new",
  wrap: HTMLElement,
): HTMLElement {
  const cell = el("span", cls);
  if (no !== undefined) {
    const line = no;
    const gut = el("span", "sgut cm", "💬");
    gut.title = `comment on ${side} line ${line}`;
    gut.onclick = (e) => {
      e.stopPropagation();
      const s = selectionFor(file, line);
      openCompose(wrap, file, s.start, s.end, side);
      clearSelection();
    };
    cell.append(gut);
  }
  cell.append(el("span", "n", no !== undefined ? String(no) : ""));
  return cell;
}

// One code cell: highlighted code plus, when the line exists, the comment anchor
// (file + line + side) so native-selection comments resolve to the right side.
function codeCell(
  l: Line | undefined,
  no: number | undefined,
  real: boolean,
  lang: string | null,
  file: string,
  side: "old" | "new",
): HTMLElement {
  const cell = el("span", `gcode${real ? ` ${side}` : ""}`);
  if (l) cell.append(codeSpan(l.text, lang));
  if (no !== undefined) {
    cell.dataset.file = file;
    cell.dataset.line = String(no);
    cell.dataset.side = side;
  }
  return cell;
}

// Emit one diff line as four grid cells (old #, old code, new #, new code) into a
// display:contents row wrapper. Both sides carry a gutter + anchor, so comments
// land on deleted (left) and added/context (right) lines alike.
function emitLine(
  grid: HTMLElement,
  d: Line | undefined,
  a: Line | undefined,
  lang: string | null,
  file: string,
): void {
  const wrap = el("div", "srow");
  wrap.append(numCell(d?.oldNo, `gno${d?.kind === "del" ? " del" : ""}`, file, "old", wrap));
  wrap.append(codeCell(d, d?.oldNo, d?.kind === "del", lang, file, "old"));
  wrap.append(numCell(a?.newNo, `gno gsep${a?.kind === "add" ? " add" : ""}`, file, "new", wrap));
  wrap.append(codeCell(a, a?.newNo, a?.kind === "add", lang, file, "new"));
  grid.append(wrap);
}

// Side-by-side diff as a single CSS grid: old/new columns share one horizontal
// scroll, columns auto-align across every row, and each thread is a grid item
// inserted right after its line on its own side (old → left half, new → right).
function splitBody(f: DiffFile, lines: Line[], lang: string | null): HTMLElement {
  const grid = el("div", "splitgrid");
  const newByLine: Record<number, ThreadView[]> = {};
  const oldByLine: Record<number, ThreadView[]> = {};
  for (const t of f.threads) ((t.side === "old" ? oldByLine : newByLine)[t.line] ||= []).push(t);

  const threadsFor = (line: number | undefined, side: "old" | "new") => {
    const th = line !== undefined ? (side === "old" ? oldByLine : newByLine)[line] : undefined;
    if (!th) return;
    for (const t of th) {
      const box = renderThread(t);
      box.classList.add(side);
      grid.append(box);
    }
  };

  let dels: Line[] = [];
  let adds: Line[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      emitLine(grid, dels[i], adds[i], lang, f.path);
      threadsFor(dels[i]?.oldNo, "old");
      threadsFor(adds[i]?.newNo, "new");
    }
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === "expand") {
      flush();
      grid.append(expandRow(l));
    } else if (l.kind === "hunk") {
      flush();
      grid.append(el("div", "ghunk", l.text));
    } else if (l.kind === "del") dels.push(l);
    else if (l.kind === "add") adds.push(l);
    else {
      flush();
      emitLine(grid, l, l, lang, f.path);
      threadsFor(l.oldNo, "old");
      threadsFor(l.newNo, "new");
    }
  }
  flush();
  return grid;
}

// Splice hidden context (from the file's current content) into the gaps between
// hunks, gated by expandedGaps: each gap starts as a clickable "expand" control
// and reveals EXPAND_STEP more lines per click. Revealed lines are plain context,
// so they render — and accept comments — like any other line.

// Clickable "expand context" row; reveals EXPAND_STEP more lines of its gap.
function expandRow(l: Line): HTMLElement {
  const g = l.gap;
  const row = el("div", "expand-row");
  if (!g) return row;
  const hidden = g.up ?? g.down ?? 0;
  const step = Math.min(hidden, EXPAND_STEP);
  row.textContent = `↕ expand ${step} line${step === 1 ? "" : "s"}${hidden > EXPAND_STEP ? ` · ${hidden} hidden` : ""}`;
  row.title = "Show more context";
  row.onclick = () => {
    expandedGaps.set(g.key, (expandedGaps.get(g.key) ?? 0) + EXPAND_STEP);
    rerender();
  };
  return row;
}

/** The file's diff rows in the given view mode, hidden context spliced in as revealed so far. */
export function renderDiffBody(f: DiffFile, mode: string): HTMLElement {
  const lang = langFor(f.path);
  const lines = withExpansions(f, parsePatch(f.patch), expandedGaps);
  return mode === "split" ? splitBody(f, lines, lang) : inlineBody(f, lines, lang);
}
