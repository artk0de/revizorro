import { el } from "./view/dom.js";
import { LOCKFILE } from "./view/patch.js";
import { setBridge, send } from "./view/bridge.js";
import { trackActivity } from "./view/activity.js";
import { renderSummary, renderBranch, renderAgentStatus } from "./view/summary.js";
import {
  renderTree,
  setTreeVisible,
  isTreeVisible,
  applyTreeWidth,
  bindTreeResizer,
  bindTreeHotkey,
} from "./view/tree.js";
import { focusSnapshot, restoreFocus } from "./view/drafts.js";
import {
  unresolvedThreadIds,
  allThreadIds,
  threadElement,
  stepId,
  jumpTo,
  renderThreadNav,
} from "./view/navigate.js";
import {
  isFindOpen,
  runFind,
  reapplyFind,
  stepFind,
  openFind,
  closeFind,
  toggleFindBar,
} from "./view/find.js";
import { openComposeAt, reopenCompose, type ThreadView } from "./view/thread.js";
import { renderDiffBody, setRerender } from "./view/diff-body.js";

declare function acquireVsCodeApi(): { postMessage: (m: unknown) => void };
const vscode = acquireVsCodeApi();
setBridge((m) => {
  vscode.postMessage(m);
});
send({ type: "ready" });
setRerender(render);
// Any input anywhere in the form counts, so listen at the document.
trackActivity(document);

interface Msg {
  type: string;
  round: number;
  status: string;
  scope?: { stagedOnly: boolean; baseRef: string };
  branch?: string;
  agentWaiting?: boolean;
  viewMode?: string;
  files: FileView[];
}
interface FileView {
  path: string;
  /** Set when git detected a rename — the path this file used to live at. */
  oldPath?: string;
  patch: string;
  content: string;
  binary: boolean;
  viewed: boolean;
  threads: ThreadView[];
}

let state: Msg | null = null;

const baseName = (path: string): string => path.split("/").pop() ?? path;

// A moved file keeps its name, a renamed one doesn't — GitLab/GitHub label the two
// differently, and the distinction is what tells you whether to re-read the diff.
function renamePath(f: FileView): { label: HTMLElement; tag: string } {
  const label = el("span", "path");
  if (!f.oldPath) {
    label.textContent = f.path;
    return { label, tag: "" };
  }
  label.append(
    el("span", "oldpath", f.oldPath),
    el("span", "movearrow", " → "),
    document.createTextNode(f.path),
  );
  return { label, tag: baseName(f.oldPath) === baseName(f.path) ? "moved" : "renamed" };
}

function renderFile(f: FileView, mode: string): HTMLElement {
  const lineCount = f.patch ? f.patch.split("\n").length : 0;
  const big = LOCKFILE.test(f.path) || lineCount > 400;
  const collapsed = f.viewed || big;
  const wrap = el("div", `file${f.viewed ? " viewed" : ""}`);
  wrap.dataset.path = f.path;
  const head = el("div", "file-head");
  const caret = el("span", "caret", collapsed ? "▸" : "▾");
  const { label: path, tag: moveTag } = renamePath(f);
  const tag = el(
    "span",
    "tag",
    f.binary ? "binary" : big ? `${lineCount} lines — collapsed` : moveTag,
  );
  if (moveTag && !f.binary && !big) tag.classList.add("move");
  const chk = el("label", "viewed-chk");
  const cbox = document.createElement("input");
  cbox.type = "checkbox";
  cbox.checked = f.viewed;
  cbox.onclick = (e) => {
    e.stopPropagation();
    send({ type: "setViewed", file: f.path, viewed: cbox.checked });
  };
  chk.append(cbox, document.createTextNode(" viewed"));
  head.append(caret, path, tag, chk);

  const diff = el("div", "diff");
  diff.style.display = collapsed ? "none" : "block";
  head.onclick = () => {
    diff.style.display = diff.style.display === "none" ? "block" : "none";
    caret.textContent = diff.style.display === "none" ? "▸" : "▾";
  };
  if (f.binary) diff.append(el("div", "binary", "(binary file — no textual diff)"));
  else {
    if (mode === "split") diff.classList.add("split");
    diff.append(renderDiffBody(f, mode));
  }
  wrap.append(head, diff);
  return wrap;
}

function render(): void {
  if (!state) return;
  // An agent push rebuilds the form under the human's hands; keep the caret where
  // it was so an arriving reply does not interrupt a sentence.
  const focus = focusSnapshot();
  const round = document.getElementById("round");
  if (round) round.textContent = `round ${state.round} · ${state.status}`;
  renderSummary(state.files, state.scope);
  renderBranch(state.branch ?? "");

  const toggle = document.getElementById("toggle");
  if (toggle) {
    const mode = state.viewMode || "inline";
    toggle.innerHTML = `⇆ <span class="${mode === "inline" ? "on" : ""}">inline</span> / <span class="${mode === "split" ? "on" : ""}">split</span>`;
  }
  // One place says what the agent is doing: answering, listening, or gone.
  const pendingCount = state.files.reduce(
    (n, f) => n + f.threads.filter((t) => t.pending).length,
    0,
  );
  renderAgentStatus(state.agentWaiting, pendingCount);
  const root = document.getElementById("files");
  if (!root) return;
  root.innerHTML = "";
  renderTree(state.files);
  if (!state.files.length) {
    root.append(el("div", "empty", "no changes in the worktree"));
    restoreFocus(focus);
    return;
  }
  // One unrenderable file must not cost the human the rest of the review: without
  // this, a throw part-way through left the tree listing files whose diff cards had
  // never been built, so the sidebar pointed at nothing and the form looked dead.
  for (const f of state.files) {
    try {
      root.append(renderFile(f, state.viewMode || "inline"));
    } catch (e) {
      const failed = el("div", "file");
      failed.dataset.path = f.path;
      const head = el("div", "file-head");
      head.append(el("span", "path", f.path), el("span", "tag", "could not be rendered"));
      failed.append(head, el("div", "binary", String(e instanceof Error ? e.message : e)));
      root.append(failed);
    }
  }
  reopenCompose();
  // Re-rendering threw away the highlights and changed how many threads are
  // open; both controls have to catch up before the human touches them again.
  refreshThreadNav();
  reapplyFind();
  // Editors reopen in a microtask, so put the caret back after they exist.
  queueMicrotask(() => {
    restoreFocus(focus);
  });
}

/** Which open thread the human is parked on — an id, so it survives a re-render. */
let currentThreadId: string | null = null;

function refreshThreadNav(): void {
  renderThreadNav(unresolvedThreadIds(), currentThreadId, allThreadIds());
}

function gotoThread(dir: 1 | -1): void {
  // Diff order including resolved threads: the cursor keeps its place when the
  // thread under it is ticked off, so "next" reaches the one after it.
  const next = stepId(unresolvedThreadIds(), currentThreadId, dir, allThreadIds());
  if (!next) return;
  currentThreadId = next;
  const box = threadElement(next);
  if (box) jumpTo(box);
  refreshThreadNav();
}

function bindNavigation(): void {
  document.getElementById("threadPrev")?.addEventListener("click", () => {
    gotoThread(-1);
  });
  document.getElementById("threadNext")?.addEventListener("click", () => {
    gotoThread(1);
  });
  document.getElementById("findPrev")?.addEventListener("click", () => {
    stepFind(-1);
  });
  document.getElementById("findNext")?.addEventListener("click", () => {
    stepFind(1);
  });

  document.getElementById("findToggle")?.addEventListener("click", () => {
    toggleFindBar();
  });
  document.getElementById("findClose")?.addEventListener("click", () => {
    closeFind();
  });

  const input = document.getElementById("findInput");
  if (input instanceof HTMLInputElement) {
    input.addEventListener("input", () => {
      runFind(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeFind();
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    // Cmd/Ctrl+F is what a reviewer's hands already do; the host's own find
    // widget never surfaced in this webview, so the form answers for it.
    if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      toggleFindBar();
      return;
    }
    // Esc closes the bar from anywhere, including after a click into the diff.
    if (e.key === "Escape" && isFindOpen()) {
      closeFind();
      return;
    }
    const target = e.target as HTMLElement | null;
    const typing =
      target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") {
      e.preventDefault();
      openFind();
    } else if (e.key === "n") {
      e.preventDefault();
      gotoThread(1);
    } else if (e.key === "p") {
      e.preventDefault();
      gotoThread(-1);
    }
  });
  refreshThreadNav();
}

function bindButton(id: string, msgType: string): void {
  const btn = document.getElementById(id);
  if (btn) {
    btn.onclick = () => {
      send({ type: msgType });
    };
  }
}
bindButton("approve", "approve");
bindButton("requestChanges", "requestChanges");
bindButton("clarify", "clarify");
bindButton("toggle", "toggleViewMode");

const treeToggle = document.getElementById("treeToggle");
if (treeToggle) {
  treeToggle.onclick = () => {
    setTreeVisible(!isTreeVisible());
  };
}
setTreeVisible(isTreeVisible());
bindTreeHotkey();
applyTreeWidth();
bindTreeResizer();
bindNavigation();

// Native text selection → floating "Comment" bubble. Select any code (part of a
// line or across lines) and a bubble offers to comment on the spanned range.
function rowOf(node: Node | null): HTMLElement | null {
  const elt = node?.nodeType === 3 ? node.parentElement : (node as Element | null);
  return (elt?.closest(".ln, .gcode") as HTMLElement | null) ?? null;
}
let bubble: HTMLElement | null = null;
function clearBubble(): void {
  bubble?.remove();
  bubble = null;
}
// Constrain a split selection to one side: on mousedown, tag which side is being
// selected so user-select disables the other (kills the mirrored cross-side drag).
document.addEventListener("mousedown", (e) => {
  document.querySelectorAll(".splitgrid").forEach((g) => {
    g.classList.remove("sel-old", "sel-new");
  });
  const cell =
    e.target instanceof Element ? e.target.closest<HTMLElement>(".gcode[data-side]") : null;
  const side = cell?.dataset.side;
  if (side) cell?.closest(".splitgrid")?.classList.add(side === "old" ? "sel-old" : "sel-new");
});
document.addEventListener("mouseup", (e) => {
  // Don't dismiss the bubble when the click is the bubble itself — let its
  // onclick fire (otherwise the button is unclickable).
  if (bubble && e.target instanceof Node && bubble.contains(e.target)) return;
  clearBubble();
  const selObj = window.getSelection();
  if (!selObj || selObj.isCollapsed || selObj.rangeCount === 0 || !selObj.toString().trim()) return;
  const startRow = rowOf(selObj.anchorNode);
  const endRow = rowOf(selObj.focusNode);
  const file = startRow?.dataset.file;
  if (!file) return;
  // Comment on the side where the selection started (old = deleted, new = added).
  const side = (startRow?.dataset.side as "old" | "new" | undefined) ?? "new";
  const nums = [startRow, endRow]
    .map((r) => (r?.dataset.line ? parseInt(r.dataset.line, 10) : NaN))
    .filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return;
  const startLine = Math.min(...nums);
  const endLine = Math.max(...nums);
  const snippet = selObj.toString();
  const label = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  const b = el("button", "sel-bubble primary", `💬 Comment on ${label}`);
  // Anchor at the cursor where the drag ended — on the active side — instead of a
  // multi-row range rect that geometrically spans both columns (= always left).
  b.style.top = `${e.clientY + window.scrollY + 8}px`;
  b.style.left = `${e.clientX + window.scrollX}px`;
  b.onclick = () => {
    clearBubble();
    openComposeAt(file, startLine, endLine, side, snippet);
  };
  bubble = b;
  document.body.append(b);
});

window.addEventListener("message", (e: MessageEvent) => {
  if ((e.data as Msg).type !== "state") return;
  state = e.data as Msg;
  render();
});
