import { el } from "./view/dom.js";
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
import { focusSnapshot, restoreFocus, type FocusSnapshot } from "./view/drafts.js";
import { gotoThread, refreshThreadNav } from "./view/navigate.js";
import {
  isFindOpen,
  runFind,
  reapplyFind,
  stepFind,
  openFind,
  closeFind,
  toggleFindBar,
} from "./view/find.js";
import { reopenCompose } from "./view/thread.js";
import { setRerender } from "./view/diff-body.js";
import { renderFile, renderFailedFile, type CardFile } from "./view/file-card.js";
import { bindCommentBubble } from "./view/comment-bubble.js";

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
  files: CardFile[];
}

let state: Msg | null = null;

function renderViewModeToggle(viewMode: string | undefined): void {
  const toggle = document.getElementById("toggle");
  if (!toggle) return;
  const mode = viewMode || "inline";
  toggle.innerHTML = `⇆ <span class="${mode === "inline" ? "on" : ""}">inline</span> / <span class="${mode === "split" ? "on" : ""}">split</span>`;
}

/** The chrome above the diff: round, summary, branch, view mode, agent status. */
function renderHeader(s: Msg): void {
  const round = document.getElementById("round");
  if (round) round.textContent = `round ${s.round} · ${s.status}`;
  renderSummary(s.files, s.scope);
  renderBranch(s.branch ?? "");
  renderViewModeToggle(s.viewMode);
  // One place says what the agent is doing: answering, listening, or gone.
  const pendingCount = s.files.reduce((n, f) => n + f.threads.filter((t) => t.pending).length, 0);
  renderAgentStatus(s.agentWaiting, pendingCount);
}

function renderFiles(root: HTMLElement, files: CardFile[], mode: string): void {
  // One unrenderable file must not cost the human the rest of the review: without
  // this, a throw part-way through left the tree listing files whose diff cards had
  // never been built, so the sidebar pointed at nothing and the form looked dead.
  for (const f of files) {
    try {
      root.append(renderFile(f, mode));
    } catch (e) {
      root.append(renderFailedFile(f.path, e));
    }
  }
}

/** Bring back what the human had going before the rebuild threw it away. */
function restoreTransientUi(focus: FocusSnapshot | null): void {
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

function render(): void {
  if (!state) return;
  // An agent push rebuilds the form under the human's hands; keep the caret where
  // it was so an arriving reply does not interrupt a sentence.
  const focus = focusSnapshot();
  renderHeader(state);
  const root = document.getElementById("files");
  if (!root) return;
  root.innerHTML = "";
  renderTree(state.files);
  if (!state.files.length) {
    root.append(el("div", "empty", "no changes in the worktree"));
    restoreFocus(focus);
    return;
  }
  renderFiles(root, state.files, state.viewMode || "inline");
  restoreTransientUi(focus);
}

function onClick(id: string, fn: () => void): void {
  document.getElementById(id)?.addEventListener("click", () => {
    fn();
  });
}

function bindNavButtons(): void {
  onClick("threadPrev", () => {
    gotoThread(-1);
  });
  onClick("threadNext", () => {
    gotoThread(1);
  });
  onClick("findPrev", () => {
    stepFind(-1);
  });
  onClick("findNext", () => {
    stepFind(1);
  });
  onClick("findToggle", toggleFindBar);
  onClick("findClose", closeFind);
}

function bindFindInput(): void {
  const input = document.getElementById("findInput");
  if (!(input instanceof HTMLInputElement)) return;
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

function onNavHotkey(e: KeyboardEvent): void {
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
}

function bindNavigation(): void {
  bindNavButtons();
  bindFindInput();
  document.addEventListener("keydown", onNavHotkey);
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
bindCommentBubble();

window.addEventListener("message", (e: MessageEvent) => {
  if ((e.data as Msg).type !== "state") return;
  state = e.data as Msg;
  render();
});
