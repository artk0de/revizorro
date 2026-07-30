import { buildFileTree, fileReviewState, type FileTreeNode } from "@revizorro/core";
import { el } from "./dom.js";
import { diffStat } from "./patch.js";

/** What the navigator needs to know about one file. */
export interface TreeFile {
  path: string;
  oldPath?: string;
  patch: string;
  binary: boolean;
  viewed: boolean;
  threads: { resolved: boolean }[];
}

/** Directories the human collapsed, and whether the sidebar itself is showing. */
const collapsedDirs = new Set<string>();
let treeVisible = true;
let treeWidth = 17;

/** Find a file's diff card without building a selector out of its path. */
function cardFor(path: string): HTMLElement | null {
  // Scoped to the diff column: a sidebar row also carries class "file" and its own
  // path, and must never be mistaken for the card it points at.
  const cards = [...document.querySelectorAll<HTMLElement>("#files .file[data-path]")];
  return cards.find((card) => card.dataset.path === path) ?? null;
}

/** Jump to a file's diff, opening it if it is collapsed. */
export function revealFile(path: string): void {
  const card = cardFor(path);
  if (!card) return;
  // Viewed and oversized files render collapsed — jumping to a closed header looks
  // like nothing happened, so open it on the way in.
  const diff = card.querySelector<HTMLElement>(".diff");
  if (diff?.style.display === "none") {
    diff.style.display = "block";
    const caret = card.querySelector<HTMLElement>(".caret");
    if (caret) caret.textContent = "▾";
  }
  // Optional: not every host implements smooth scrolling, and failing to scroll
  // must not cost the human the expansion above.
  card.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

/** The marker shown before a file: unresolved work outranks every "done" signal. */
export function fileMarker(f: TreeFile): { glyph: string; kind: string; title: string } {
  const s = fileReviewState(f.threads, f.viewed);
  if (s.openThreads > 0) {
    return { glyph: "●", kind: "open", title: `${s.openThreads} unresolved thread(s)` };
  }
  if (s.allResolved) return { glyph: "✓", kind: "done", title: "all threads resolved" };
  if (f.viewed) return { glyph: "✓", kind: "seen", title: "marked viewed" };
  return { glyph: "•", kind: "todo", title: "not reviewed yet" };
}

function treeRows(node: FileTreeNode, depth: number, byPath: Map<string, TreeFile>): HTMLElement[] {
  const row = el("div", `node ${node.kind}`);
  row.style.paddingLeft = `${0.3 + depth * 0.7}rem`;

  if (node.kind === "dir") {
    const open = !collapsedDirs.has(node.path);
    row.append(el("span", "tcaret", open ? "▾" : "▸"), el("span", "nm", node.name));
    row.dataset.dir = node.path;
    row.onclick = () => {
      if (open) collapsedDirs.add(node.path);
      else collapsedDirs.delete(node.path);
      row.dispatchEvent(new CustomEvent("tree-toggle", { bubbles: true }));
    };
    const kids = el("div", "tkids");
    kids.style.display = open ? "block" : "none";
    kids.append(...node.children.flatMap((c) => treeRows(c, depth + 1, byPath)));
    return [row, kids];
  }

  const f = byPath.get(node.path);
  if (!f) {
    row.append(el("span", "nm", node.name));
    return [row];
  }
  const s = fileReviewState(f.threads, f.viewed);
  const marker = fileMarker(f);
  const mark = el("span", `mark ${marker.kind}`, marker.glyph);
  mark.title = marker.title;
  row.append(mark, el("span", "nm", node.name));
  row.dataset.file = f.path;
  if (f.viewed && !s.needsAttention) row.classList.add("viewed");
  if (s.allResolved) row.classList.add("allresolved");
  if (s.needsAttention) row.classList.add("attention");
  if (f.oldPath) row.classList.add("moved");

  const stat = el("span", "stat");
  if (s.openThreads > 0) stat.append(el("span", "cmt", `💬${s.openThreads} `));
  if (!f.binary) {
    const { add, del } = diffStat(f.patch);
    if (add > 0) stat.append(el("span", "add", `+${add}`));
    if (add > 0 && del > 0) stat.append(document.createTextNode(" "));
    if (del > 0) stat.append(el("span", "del", `−${del}`));
  }
  row.append(stat);
  const where = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  const threadNote =
    s.openThreads > 0
      ? `${s.openThreads} unresolved`
      : s.allResolved
        ? "all threads resolved"
        : f.viewed
          ? "viewed"
          : "not reviewed";
  row.title = `${where}\n${threadNote}`;
  row.onclick = () => {
    revealFile(f.path);
  };
  return [row];
}

/** Paint the navigator, keeping the reader's scroll position across re-renders. */
export function renderTree(files: TreeFile[]): void {
  const root = document.getElementById("tree");
  if (!root) return;
  const scroll = root.scrollTop;
  root.innerHTML = "";
  const states = files.map((f) => fileReviewState(f.threads, f.viewed));
  const openTotal = states.reduce((n, s) => n + s.openThreads, 0);
  const doneCount = states.filter((s) => !s.needsAttention).length;
  const head = el("div", "tree-head");
  head.append(el("span", "nm", `${files.length} file${files.length === 1 ? "" : "s"}`));
  const summary = el("span", "stat");
  if (openTotal > 0) summary.append(el("span", "cmt", `💬${openTotal} open`));
  else summary.append(el("span", "done", `${doneCount}/${files.length} done`));
  head.append(summary);
  // The size of the change belongs next to the list of what changed, not in the
  // toolbar competing with the decision buttons.
  let add = 0;
  let del = 0;
  for (const f of files) {
    if (f.binary) continue;
    const d = diffStat(f.patch);
    add += d.add;
    del += d.del;
  }
  const totals = el("span", "tree-totals");
  totals.append(el("span", "add", `+${add}`), document.createTextNode("  "), el("span", "del", `-${del}`));
  head.append(totals);
  root.append(head);
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const node of buildFileTree(files.map((f) => f.path))) {
    root.append(...treeRows(node, 0, byPath));
  }
  root.scrollTop = scroll;
}

export function isTreeVisible(): boolean {
  return treeVisible;
}

export function setTreeVisible(visible: boolean): void {
  treeVisible = visible;
  document.getElementById("main")?.classList.toggle("tree-hidden", !visible);
  document.getElementById("treeToggle")?.classList.toggle("on", visible);
}

let hotkeyBound = false;

/**
 * `t` folds the navigator away. No modifier, so it cannot collide with an editor
 * shortcut, and inert while the caret sits in a field — otherwise typing "t" into
 * a comment would make the sidebar jump.
 */
export function bindTreeHotkey(): void {
  if (hotkeyBound) return;
  hotkeyBound = true;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "t" && e.key !== "T") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
    if (target?.isContentEditable) return;
    e.preventDefault();
    setTreeVisible(!treeVisible);
  });
}

export function applyTreeWidth(): void {
  document.getElementById("main")?.style.setProperty("--tree-w", `${treeWidth}rem`);
}

/** Drag the divider to resize the navigator; the width outlives re-renders. */
export function bindTreeResizer(): void {
  const grip = document.getElementById("treeResizer");
  const main = document.getElementById("main");
  if (!grip || !main) return;
  grip.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = treeWidth;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const onMove = (m: MouseEvent): void => {
      treeWidth = Math.min(45, Math.max(9, startWidth + (m.clientX - startX) / rem));
      applyTreeWidth();
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** Test seam: forget collapsed directories and sidebar geometry. */
export function resetTree(): void {
  collapsedDirs.clear();
  treeVisible = true;
  treeWidth = 17;
}
