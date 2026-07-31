import { langFor, hl, renderMarkdown } from "./view/highlight.js";
import { el, codeSpan, onSubmit, autoGrow } from "./view/dom.js";
import {
  parsePatch,
  withExpansions,
  LOCKFILE,
  EXPAND_STEP,
  type Line,
} from "./view/patch.js";
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
import {
  bindDraft,
  clearDraft,
  markEditorOpen,
  markEditorClosed,
  isEditorOpen,
  focusSnapshot,
  restoreFocus,
} from "./view/drafts.js";
import {
  unresolvedThreadIds,
  threadElement,
  stepId,
  stepIndex,
  jumpTo,
  renderThreadNav,
} from "./view/navigate.js";
import { markMatches, setFindOpen, isFindOpen, toggleFind } from "./view/find.js";
import { composeDraftKey, replyDraftKey, editDraftKey } from "@revizorro/core";

declare function acquireVsCodeApi(): { postMessage: (m: unknown) => void };
const vscode = acquireVsCodeApi();
setBridge((m) => {
  vscode.postMessage(m);
});
send({ type: "ready" });
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
  threads: {
    id: string;
    line: number;
    side: "old" | "new";
    resolved: boolean;
    pending: boolean;
    messages: { author: string; body: string }[];
  }[];
}

// How many lines each expand control reveals per click, and how many context
// lines already revealed per gap (keyed `${file}#${gapId}`), across re-renders.
const expandedGaps = new Map<string, number>();

let state: Msg | null = null;
let sel: { file: string; start: number; end: number } | null = null;
// The composer currently open, if any. An incoming agent reply re-renders the
// whole form; this lets render() reopen the composer (with its draft) instead of
// silently dropping what the human was typing.
let activeCompose: { file: string; startLine: number; endLine: number; side: "old" | "new"; snippet?: string } | null = null;

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

function renderBody(body: string): HTMLElement {
  const wrap = el("div", "msg-body");
  wrap.innerHTML = renderMarkdown(body);
  return wrap;
}

function inlineBody(f: FileView, lines: Line[], lang: string | null): HTMLElement {
  const body = el("div");
  // Keyed by side: a removed line and an added line can share a number, and putting
  // both threads on whichever row came first anchors half of them to the wrong code.
  const byNew: Record<number, FileView["threads"]> = {};
  const byOld: Record<number, FileView["threads"]> = {};
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
    const th = l.newNo !== undefined ? byNew[l.newNo] : l.oldNo !== undefined ? byOld[l.oldNo] : undefined;
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
function codeCell(l: Line | undefined, no: number | undefined, real: boolean, lang: string | null, file: string, side: "old" | "new"): HTMLElement {
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
function emitLine(grid: HTMLElement, d: Line | undefined, a: Line | undefined, lang: string | null, file: string): void {
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
function splitBody(f: FileView, lines: Line[], lang: string | null): HTMLElement {
  const grid = el("div", "splitgrid");
  const newByLine: Record<number, FileView["threads"]> = {};
  const oldByLine: Record<number, FileView["threads"]> = {};
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

function avatar(author: string): HTMLElement {
  const a = el("span", `avatar ${author === "agent" ? "agent" : "human"}`);
  a.textContent = author === "agent" ? "R" : "Y";
  return a;
}

function renderThread(t: FileView["threads"][number]): HTMLElement {
  const box = el("div", `thread${t.resolved ? " resolved" : ""}`);
  // Thread navigation keeps its place across re-renders by id, not by position:
  // an agent reply arriving mid-walk must not shift the human somewhere else.
  box.dataset.id = t.id;
  const bar = el("div", "thread-bar");
  const caret = el("span", "tcaret", t.resolved ? "▸" : "▾");
  bar.append(
    caret,
    el("span", "status", t.resolved ? "✓ resolved" : `${t.messages.length} comment(s)`),
    el("span", "grow"),
  );
  const resolveBtn = el("button", "ghost", t.resolved ? "Unresolve" : "Resolve");
  resolveBtn.onclick = (e) => {
    e.stopPropagation();
    send({ type: "resolve", threadId: t.id, resolved: !t.resolved });
  };
  bar.append(resolveBtn);
  box.append(bar);

  const content = el("div", "thread-content");
  content.style.display = t.resolved ? "none" : "block";
  bar.onclick = () => {
    const open = content.style.display === "none";
    content.style.display = open ? "block" : "none";
    caret.textContent = open ? "▾" : "▸";
  };

  // Edit your own posts in an unresolved thread: a pencil on each human message,
  // plus an ↑ hotkey from the reply box that opens the newest one for editing.
  const editFns: (() => void)[] = [];
  t.messages.forEach((m, i) => {
    // The first message is the root comment; everything after is a reply —
    // indent replies under a left rail so the conversation reads as a thread.
    const msg = el("div", i === 0 ? "msg" : "msg reply");
    const head = el("div", "msg-head");
    head.append(avatar(m.author), el("span", "who", m.author === "agent" ? "revizorro" : "you"));
    const bodyEl = renderBody(m.body);
    const editKey = editDraftKey(t.id, i);
    const startEdit = () => {
      if (msg.querySelector(".msg-edit")) return;
      markEditorOpen(editKey);
      const editor = el("div", "msg-edit");
      const ta = document.createElement("textarea");
      ta.className = "edit-ta";
      ta.value = m.body;
      // A draft only exists if this edit was interrupted by a re-render.
      bindDraft(ta, editKey);
      const restore = () => {
        markEditorClosed(editKey);
        editor.replaceWith(bodyEl);
      };
      const saveFn = () => {
        const v = ta.value.trim();
        if (v) send({ type: "editMessage", threadId: t.id, index: i, body: v });
        restore();
      };
      const save = el("button", "primary", "Save");
      const cancel = el("button", "ghost cancel", "Cancel");
      save.onclick = saveFn;
      cancel.onclick = restore;
      onSubmit(ta, saveFn, saveFn);
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") restore();
      });
      const acts = el("div", "compose-actions");
      acts.append(save, cancel);
      editor.append(ta, acts);
      bodyEl.replaceWith(editor);
      autoGrow(ta);
      ta.focus();
    };
    if (m.author === "human" && !t.resolved) {
      editFns.push(startEdit);
      const edit = el("button", "ghost icon-edit", "✏️");
      edit.title = "Edit (↑)";
      edit.onclick = startEdit;
      head.append(el("span", "grow"), edit);
    }
    msg.append(head, bodyEl);
    content.append(msg);
    // This message was being edited when the form re-rendered — reopen the editor
    // so the human keeps typing where they left off.
    if (isEditorOpen(editKey)) queueMicrotask(startEdit);
  });

  if (t.pending) {
    const loader = el("div", "loader");
    loader.append(el("span", "spinner"), document.createTextNode(" revizorro is replying…"));
    content.append(loader);
  }

  if (!t.resolved) {
    const composer = el("div", "reply-box");
    const ta = document.createElement("textarea");
    ta.rows = 1;
    ta.placeholder = "Reply…  (⌘/Ctrl+Enter reply · ⌥+Enter ask · ↑ edit last)";
    bindDraft(ta, replyDraftKey(t.id));
    const postReply = (type: "reply" | "askReply") => {
      const v = ta.value.trim();
      if (v) send({ type, threadId: t.id, body: v });
      ta.value = "";
      clearDraft(replyDraftKey(t.id));
    };
    const replyFn = () => {
      postReply("reply");
    };
    const askFn = () => {
      postReply("askReply");
    };
    const reply = el("button", undefined, "Reply");
    const ask = el("button", "primary", "Ask agent");
    reply.onclick = replyFn;
    ask.onclick = askFn;
    onSubmit(ta, replyFn, askFn);
    // ↑ on an empty reply box edits your most recent post (terminal/Slack style).
    ta.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" && ta.value === "" && editFns.length > 0) {
        e.preventDefault();
        editFns[editFns.length - 1]();
      }
    });
    autoGrow(ta);
    composer.append(ta, reply, ask);
    content.append(composer);
  }
  box.append(content);
  return box;
}

function openCompose(
  row: HTMLElement,
  file: string,
  startLine: number,
  endLine: number,
  side: "old" | "new",
  snippet?: string,
): void {
  // Only one composer open at a time.
  document.querySelectorAll(".compose").forEach((e) => {
    e.remove();
  });
  activeCompose = { file, startLine, endLine, side, snippet };
  const box = el("div", `compose ${side}`);
  if (snippet) {
    const pre = el("pre", "snippet");
    pre.innerHTML = hl(snippet, langFor(file));
    box.append(pre);
  }
  const ta = document.createElement("textarea");
  ta.rows = 2;
  const where = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  ta.placeholder = `Comment on ${where}…  (⌘/Ctrl+Enter comment · ⌘/Ctrl+Alt+Enter ask · Esc cancel)`;
  const draftKey = composeDraftKey(file, side, startLine, endLine);
  bindDraft(ta, draftKey);
  // Carry the selected code into the comment so the agent sees the exact piece.
  const withSnippet = (v: string) => (snippet ? `\`\`\`\n${snippet}\n\`\`\`\n\n${v}` : v);
  const close = () => {
    activeCompose = null;
    box.remove();
  };
  const commentFn = () => {
    const v = ta.value.trim();
    if (v) send({ type: "comment", file, side, startLine, endLine, body: withSnippet(v) });
    clearDraft(draftKey);
    close();
  };
  const askFn = () => {
    const v = ta.value.trim();
    if (v) send({ type: "ask", file, side, startLine, endLine, body: withSnippet(v) });
    clearDraft(draftKey);
    close();
  };
  const commentBtn = el("button", undefined, "Comment");
  const ask = el("button", "primary", "Ask agent");
  const cancel = el("button", "ghost cancel", "Cancel");
  commentBtn.onclick = commentFn;
  ask.onclick = askFn;
  cancel.onclick = close;
  onSubmit(ta, commentFn, askFn);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  const actions = el("div", "compose-actions");
  actions.append(commentBtn, ask, cancel);
  box.append(ta, actions);
  // In split, anchor the composer after the line's grid row so it spans full
  // width as its own grid item; in inline it just follows the clicked line.
  const block = row.closest(".srow") ?? row;
  block.after(box);
  autoGrow(ta);
  ta.focus();
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
    render();
  };
  return row;
}

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
    const lang = langFor(f.path);
    const lines = withExpansions(f, parsePatch(f.patch), expandedGaps);
    if (mode === "split") {
      diff.classList.add("split");
      diff.append(splitBody(f, lines, lang));
    } else {
      diff.append(inlineBody(f, lines, lang));
    }
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
  // Reopen the composer the human had open before this re-render (e.g. an agent
  // reply landed mid-typing) so their in-progress comment survives.
  if (activeCompose) {
    const { file, startLine, endLine, side, snippet } = activeCompose;
    const anchor =
      document.querySelector(`[data-side="${side}"][data-file="${CSS.escape(file)}"][data-line="${endLine}"]`) ??
      document.querySelector(`[data-file="${CSS.escape(file)}"][data-line="${endLine}"]`);
    if (anchor instanceof HTMLElement) openCompose(anchor, file, startLine, endLine, side, snippet);
  }
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
let findHits: HTMLElement[] = [];
let findAt = -1;

function refreshThreadNav(): void {
  renderThreadNav(unresolvedThreadIds(), currentThreadId);
}

function gotoThread(dir: 1 | -1): void {
  const next = stepId(unresolvedThreadIds(), currentThreadId, dir);
  if (!next) return;
  currentThreadId = next;
  const box = threadElement(next);
  if (box) jumpTo(box);
  refreshThreadNav();
}

function paintFindPos(): void {
  const pos = document.getElementById("findPos");
  const input = document.getElementById("findInput");
  const query = input instanceof HTMLInputElement ? input.value.trim() : "";
  if (!pos) return;
  pos.textContent = query.length < 2 ? "" : `${findAt >= 0 ? findAt + 1 : 0}/${findHits.length}`;
}

function runFind(query: string): void {
  const root = document.getElementById("files");
  if (!root) return;
  findHits = markMatches(root, query);
  findAt = -1;
  paintFindPos();
}

/** After a re-render the marks are gone; put them back rather than lying about a count. */
function reapplyFind(): void {
  const input = document.getElementById("findInput");
  if (!(input instanceof HTMLInputElement) || input.value.trim().length < 2) {
    findHits = [];
    findAt = -1;
    paintFindPos();
    return;
  }
  const wasAt = findAt;
  runFind(input.value);
  findAt = Math.min(wasAt, findHits.length - 1);
  if (findAt >= 0) findHits[findAt].classList.add("current");
  paintFindPos();
}

function stepFind(dir: 1 | -1): void {
  if (findHits.length === 0) return;
  findAt = stepIndex(findHits.length, findAt, dir);
  for (const h of findHits) h.classList.remove("current");
  const hit = findHits[findAt];
  hit.classList.add("current");
  jumpTo(hit);
  paintFindPos();
}

function openFind(): void {
  setFindOpen(true);
}

function closeFind(): void {
  setFindOpen(false);
  findHits = [];
  findAt = -1;
}

/** ⌘F and the magnifier are the same switch; closing drops the stale hit list. */
function toggleFindBar(): void {
  if (!toggleFind()) {
    findHits = [];
    findAt = -1;
  }
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
  if (btn)
    {btn.onclick = () => {
      send({ type: msgType });
    };}
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
  const cell = e.target instanceof Element ? e.target.closest<HTMLElement>(".gcode[data-side]") : null;
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
    const anchor =
      document.querySelector(`[data-side="${side}"][data-file="${CSS.escape(file)}"][data-line="${endLine}"]`) ??
      document.querySelector(`[data-file="${CSS.escape(file)}"][data-line="${endLine}"]`);
    clearBubble();
    if (anchor instanceof HTMLElement) openCompose(anchor, file, startLine, endLine, side, snippet);
  };
  bubble = b;
  document.body.append(b);
});

window.addEventListener("message", (e: MessageEvent) => {
  if ((e.data as Msg).type !== "state") return;
  state = e.data as Msg;
  render();
});
