import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import cssLang from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import ruby from "highlight.js/lib/languages/ruby";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import sql from "highlight.js/lib/languages/sql";
import MarkdownIt from "markdown-it";
import {
  buildFileTree,
  fileReviewState,
  composeDraftKey,
  replyDraftKey,
  editDraftKey,
  type FileTreeNode,
} from "@revizorro/core";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", cssLang);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("java", java);
hljs.registerLanguage("sql", sql);

declare function acquireVsCodeApi(): { postMessage: (m: unknown) => void };
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: "ready" });

interface Msg {
  type: string;
  round: number;
  status: string;
  scope?: { stagedOnly: boolean; baseRef: string };
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
interface Line {
  kind: "add" | "del" | "ctx" | "hunk" | "expand";
  oldNo?: number;
  newNo?: number;
  text: string;
  // For "expand" rows: which hidden context this control reveals when clicked.
  gap?: { file: string; key: string; up?: number; down?: number };
}

// How many lines each expand control reveals per click, and how many context
// lines already revealed per gap (keyed `${file}#${gapId}`), across re-renders.
const EXPAND_STEP = 20;
const expandedGaps = new Map<string, number>();

let state: Msg | null = null;
let sel: { file: string; start: number; end: number } | null = null;
// Unsent text — composer, thread replies, message edits — kept outside the DOM.
// Every agent push re-renders the form from scratch, and without this whatever the
// human was typing at that moment is gone. Cleared on submit.
const drafts = new Map<string, string>();
// Message editors the human had open, so a re-render reopens them instead of
// collapsing back to the rendered comment mid-edit.
const openEditors = new Set<string>();

/**
 * Keep typing alive across a re-render: remember which textarea had focus and where
 * the caret sat, then put both back once the new DOM is in place.
 */
function focusSnapshot(): { key: string; start: number; end: number } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLTextAreaElement) || !active.dataset.draftKey) return null;
  return {
    key: active.dataset.draftKey,
    start: active.selectionStart ?? 0,
    end: active.selectionEnd ?? 0,
  };
}

function restoreFocus(snap: { key: string; start: number; end: number } | null): void {
  if (!snap) return;
  const target = document.querySelector<HTMLTextAreaElement>(
    `textarea[data-draft-key="${CSS.escape(snap.key)}"]`,
  );
  if (!target) return;
  target.focus();
  target.setSelectionRange(snap.start, snap.end);
}

/** Wire a textarea to its draft: restore what was typed, and record every keystroke. */
function bindDraft(ta: HTMLTextAreaElement, draftKey: string): void {
  ta.dataset.draftKey = draftKey;
  const saved = drafts.get(draftKey);
  if (saved !== undefined) ta.value = saved;
  ta.addEventListener("input", () => {
    if (ta.value) drafts.set(draftKey, ta.value);
    else drafts.delete(draftKey);
  });
}
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

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  html: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  css: "css",
  scss: "css",
  less: "css",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  ru: "ruby",
  py: "python",
  pyi: "python",
  pyw: "python",
  go: "go",
  rs: "rust",
  java: "java",
  sql: "sql",
};
function langFor(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? null;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}
function hl(text: string, lang: string | null): string {
  if (!lang || !text) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegal: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

// Full markdown for comment bodies. html:false escapes raw HTML (XSS-safe in the
// webview); fenced ```lang blocks are highlighted through hljs; bare URLs linkify.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight: (code, lang) => hl(code, lang ? (EXT_LANG[lang] ?? lang) : null),
});

function renderBody(body: string): HTMLElement {
  const wrap = el("div", "msg-body");
  wrap.innerHTML = md.render(body);
  return wrap;
}

function parsePatch(patch: string): Line[] {
  const out: Line[] = [];
  let newNo = 0;
  let oldNo = 0;
  for (const raw of patch.split("\n")) {
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("similarity") ||
      raw.startsWith("rename ")
    ) {
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
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

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function codeSpan(text: string, lang: string | null): HTMLElement {
  const s = document.createElement("span");
  s.className = "txt";
  s.innerHTML = hl(text, lang);
  return s;
}

// Cmd/Ctrl+Enter → primary (save); Cmd/Ctrl+Alt+Enter → ask agent.
function onSubmit(ta: HTMLTextAreaElement, primary: () => void, ask: () => void): void {
  ta.onkeydown = (e) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    (e.altKey ? ask : primary)();
  };
}

// Grow a textarea to fit its content (so multi-line comments expand automatically).
function autoGrow(ta: HTMLTextAreaElement): void {
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  ta.addEventListener("input", grow);
  queueMicrotask(grow);
}

function inlineBody(f: FileView, lines: Line[], lang: string | null): HTMLElement {
  const body = el("div");
  const threadsByLine: Record<number, FileView["threads"]> = {};
  for (const t of f.threads) (threadsByLine[t.line] ||= []).push(t);
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
    if (l.newNo !== undefined) {
      const line = l.newNo;
      gut.textContent = "💬";
      gut.title = `comment on line ${line}`;
      gut.classList.add("cm");
      gut.onclick = () => {
        const sel = selectionFor(f.path, line);
        openCompose(row, f.path, sel.start, sel.end, "new");
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
    const th = l.newNo !== undefined ? threadsByLine[l.newNo] : undefined;
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
    vscode.postMessage({ type: "resolve", threadId: t.id, resolved: !t.resolved });
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
      openEditors.add(editKey);
      const editor = el("div", "msg-edit");
      const ta = document.createElement("textarea");
      ta.className = "edit-ta";
      ta.value = m.body;
      // A draft only exists if this edit was interrupted by a re-render.
      bindDraft(ta, editKey);
      const restore = () => {
        openEditors.delete(editKey);
        drafts.delete(editKey);
        editor.replaceWith(bodyEl);
      };
      const saveFn = () => {
        const v = ta.value.trim();
        if (v) vscode.postMessage({ type: "editMessage", threadId: t.id, index: i, body: v });
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
    if (openEditors.has(editKey)) queueMicrotask(startEdit);
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
    const send = (type: "reply" | "askReply") => {
      const v = ta.value.trim();
      if (v) vscode.postMessage({ type, threadId: t.id, body: v });
      ta.value = "";
      drafts.delete(replyDraftKey(t.id));
    };
    const replyFn = () => {
      send("reply");
    };
    const askFn = () => {
      send("askReply");
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
    if (v) vscode.postMessage({ type: "comment", file, side, startLine, endLine, body: withSnippet(v) });
    drafts.delete(draftKey);
    close();
  };
  const askFn = () => {
    const v = ta.value.trim();
    if (v) vscode.postMessage({ type: "ask", file, side, startLine, endLine, body: withSnippet(v) });
    drafts.delete(draftKey);
    close();
  };
  const send = el("button", undefined, "Comment");
  const ask = el("button", "primary", "Ask agent");
  const cancel = el("button", "ghost cancel", "Cancel");
  send.onclick = commentFn;
  ask.onclick = askFn;
  cancel.onclick = close;
  onSubmit(ta, commentFn, askFn);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  const actions = el("div", "compose-actions");
  actions.append(send, ask, cancel);
  box.append(ta, actions);
  // In split, anchor the composer after the line's grid row so it spans full
  // width as its own grid item; in inline it just follows the clicked line.
  const block = row.closest(".srow") ?? row;
  block.after(box);
  autoGrow(ta);
  ta.focus();
}

const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock)$/;

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Splice hidden context (from the file's current content) into the gaps between
// hunks, gated by expandedGaps: each gap starts as a clickable "expand" control
// and reveals EXPAND_STEP more lines per click. Revealed lines are plain context,
// so they render — and accept comments — like any other line.
function withExpansions(f: FileView, lines: Line[]): Line[] {
  if (!f.content) return lines;
  const contentLines = f.content.split("\n");
  if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") contentLines.pop();
  const total = contentLines.length;
  const out: Line[] = [];

  const ctxLine = (n: number, offset: number): Line => ({
    kind: "ctx",
    newNo: n,
    oldNo: n - offset,
    text: contentLines[n - 1] ?? "",
  });
  // Emit a hidden range [startNew..endNew] as revealed context + an expand control.
  // grow="up": reveal from the bottom edge (nearest the following hunk) upward;
  // grow="down": reveal from the top edge (nearest the preceding hunk) downward.
  const emitGap = (startNew: number, endNew: number, offset: number, id: string, grow: "up" | "down") => {
    const size = endNew - startNew + 1;
    if (size <= 0) return;
    const key = `${f.path}#${id}`;
    const revealed = Math.min(size, expandedGaps.get(key) ?? 0);
    const hidden = size - revealed;
    const control = (): Line => ({ kind: "expand", text: "", gap: { file: f.path, key, up: hidden } });
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

/** Added/removed line counts for the tree's +N −M column. */
function diffStat(patch: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
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
    vscode.postMessage({ type: "setViewed", file: f.path, viewed: cbox.checked });
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
    const lines = withExpansions(f, parsePatch(f.patch));
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

// File-tree sidebar (GitLab style): collapsible directories, click a file to jump
// to its diff card. Collapse state and visibility survive re-renders.
let treeVisible = true;
const collapsedDirs = new Set<string>();

function revealFile(path: string): void {
  const card = document.querySelector<HTMLElement>(`.file[data-path="${CSS.escape(path)}"]`);
  if (!card) return;
  // Viewed and oversized files render collapsed — jumping to a closed header looks
  // like nothing happened, so open it on the way in.
  const diff = card.querySelector<HTMLElement>(".diff");
  if (diff?.style.display === "none") {
    diff.style.display = "block";
    const caret = card.querySelector<HTMLElement>(".caret");
    if (caret) caret.textContent = "▾";
  }
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function treeRows(node: FileTreeNode, depth: number, byPath: Map<string, FileView>): HTMLElement[] {
  const row = el("div", `node ${node.kind}`);
  row.style.paddingLeft = `${0.3 + depth * 0.7}rem`;

  if (node.kind === "dir") {
    const open = !collapsedDirs.has(node.path);
    row.append(el("span", "tcaret", open ? "▾" : "▸"), el("span", "nm", node.name));
    row.onclick = () => {
      if (open) collapsedDirs.add(node.path);
      else collapsedDirs.delete(node.path);
      render();
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
  // Leading marker, in priority order: unresolved threads win over every "done"
  // signal, so an agent comment on a ticked-off file drags it back into view.
  const mark = el("span", "mark");
  if (s.openThreads > 0) {
    mark.textContent = "●";
    mark.classList.add("open");
    mark.title = `${s.openThreads} unresolved thread(s)`;
  } else if (s.allResolved) {
    mark.textContent = "✓";
    mark.classList.add("done");
    mark.title = "all threads resolved";
  } else if (f.viewed) {
    mark.textContent = "✓";
    mark.classList.add("seen");
    mark.title = "marked viewed";
  } else {
    mark.textContent = "•";
    mark.classList.add("todo");
    mark.title = "not reviewed yet";
  }
  row.append(mark, el("span", "nm", node.name));
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

function renderTree(files: FileView[]): void {
  const root = document.getElementById("tree");
  if (!root) return;
  // Keep the reader's place: a re-render (agent reply, resolve) must not scroll
  // the navigator back to the top.
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
  root.append(head);
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const node of buildFileTree(files.map((f) => f.path))) {
    root.append(...treeRows(node, 0, byPath));
  }
  root.scrollTop = scroll;
}

// Drag the divider to resize the navigator; the width outlives re-renders.
let treeWidth = 17;
function applyTreeWidth(): void {
  document.getElementById("main")?.style.setProperty("--tree-w", `${treeWidth}rem`);
}
function bindTreeResizer(): void {
  const grip = document.getElementById("treeResizer");
  const main = document.getElementById("main");
  if (!grip || !main) return;
  grip.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = treeWidth;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const onMove = (m: MouseEvent) => {
      treeWidth = Math.min(45, Math.max(9, startWidth + (m.clientX - startX) / rem));
      applyTreeWidth();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function setTreeVisible(visible: boolean): void {
  treeVisible = visible;
  document.getElementById("main")?.classList.toggle("tree-hidden", !visible);
  document.getElementById("treeToggle")?.classList.toggle("on", visible);
}

// Toolbar summary: what is being reviewed, how big it is, and how far the human
// has got — the three questions asked when a diff first opens.
function renderSummary(files: FileView[]): void {
  const scopeEl = document.getElementById("scope");
  if (scopeEl) {
    const scope = state?.scope;
    scopeEl.textContent = scope?.stagedOnly
      ? "staged only"
      : `branch vs ${scope?.baseRef || "default branch"}`;
    scopeEl.title = scope?.stagedOnly
      ? "reviewing the staged change against HEAD"
      : `reviewing the branch against ${scope?.baseRef || "its target branch"}`;
  }

  const stats = document.getElementById("stats");
  if (stats) {
    stats.innerHTML = "";
    let add = 0;
    let del = 0;
    for (const f of files) {
      if (f.binary) continue;
      const d = diffStat(f.patch);
      add += d.add;
      del += d.del;
    }
    stats.append(
      el("span", undefined, `${files.length} file${files.length === 1 ? "" : "s"} `),
      el("span", "add", `+${add}`),
      document.createTextNode(" "),
      el("span", "del", `−${del}`),
    );
  }

  const done = files.filter((f) => !fileReviewState(f.threads, f.viewed).needsAttention).length;
  const pct = files.length > 0 ? Math.round((done / files.length) * 100) : 0;
  const label = document.getElementById("progressLabel");
  if (label) label.textContent = `${done}/${files.length} reviewed`;
  const bar = document.getElementById("progressBar");
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.classList.toggle("full", done === files.length && files.length > 0);
  }
  const wrap = document.getElementById("progress");
  if (wrap) {
    wrap.style.display = files.length > 0 ? "flex" : "none";
    wrap.title = `${done} of ${files.length} files reviewed (viewed, no unresolved threads)`;
  }
}

function render(): void {
  if (!state) return;
  // An agent push rebuilds the form under the human's hands; keep the caret where
  // it was so an arriving reply does not interrupt a sentence.
  const focus = focusSnapshot();
  const round = document.getElementById("round");
  if (round) round.textContent = `round ${state.round} · ${state.status}`;
  renderSummary(state.files);
  const toggle = document.getElementById("toggle");
  if (toggle) {
    const mode = state.viewMode || "inline";
    toggle.innerHTML = `⇆ <span class="${mode === "inline" ? "on" : ""}">inline</span> / <span class="${mode === "split" ? "on" : ""}">split</span>`;
  }
  const pendingCount = state.files.reduce(
    (n, f) => n + f.threads.filter((t) => t.pending).length,
    0,
  );
  const tl = document.getElementById("toploader");
  if (tl) tl.textContent = pendingCount > 0 ? `⏳ agent is answering ${pendingCount} question(s)…` : "";
  const root = document.getElementById("files");
  if (!root) return;
  root.innerHTML = "";
  renderTree(state.files);
  if (!state.files.length) {
    root.append(el("div", "empty", "no changes in the worktree"));
    restoreFocus(focus);
    return;
  }
  for (const f of state.files) root.append(renderFile(f, state.viewMode || "inline"));
  // Reopen the composer the human had open before this re-render (e.g. an agent
  // reply landed mid-typing) so their in-progress comment survives.
  if (activeCompose) {
    const { file, startLine, endLine, side, snippet } = activeCompose;
    const anchor =
      document.querySelector(`[data-side="${side}"][data-file="${CSS.escape(file)}"][data-line="${endLine}"]`) ??
      document.querySelector(`[data-file="${CSS.escape(file)}"][data-line="${endLine}"]`);
    if (anchor instanceof HTMLElement) openCompose(anchor, file, startLine, endLine, side, snippet);
  }
  // Editors reopen in a microtask, so put the caret back after they exist.
  queueMicrotask(() => {
    restoreFocus(focus);
  });
}

function bindButton(id: string, msgType: string): void {
  const btn = document.getElementById(id);
  if (btn)
    {btn.onclick = () => {
      vscode.postMessage({ type: msgType });
    };}
}
bindButton("approve", "approve");
bindButton("requestChanges", "requestChanges");
bindButton("clarify", "clarify");
bindButton("toggle", "toggleViewMode");

const treeToggle = document.getElementById("treeToggle");
if (treeToggle) {
  treeToggle.onclick = () => {
    setTreeVisible(!treeVisible);
  };
}
setTreeVisible(treeVisible);
applyTreeWidth();
bindTreeResizer();

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
