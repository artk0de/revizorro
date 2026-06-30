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
  viewMode?: string;
  files: FileView[];
}
interface FileView {
  path: string;
  patch: string;
  binary: boolean;
  viewed: boolean;
  threads: {
    id: string;
    line: number;
    resolved: boolean;
    pending: boolean;
    messages: { author: string; body: string }[];
  }[];
}
interface Line {
  kind: "add" | "del" | "ctx" | "hunk";
  oldNo?: number;
  newNo?: number;
  text: string;
}

let state: Msg | null = null;
let sel: { file: string; start: number; end: number } | null = null;
// Per-range comment drafts — survive closing/cancelling the composer and re-renders,
// so re-opening the same line restores what you'd typed. Cleared on submit.
const drafts = new Map<string, string>();

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
  document.querySelectorAll(".ln.sel").forEach((e) => {
    e.classList.remove("sel");
  });
  const cur = sel;
  if (!cur) return;
  const lo = Math.min(cur.start, cur.end);
  const hi = Math.max(cur.start, cur.end);
  document.querySelectorAll(".ln").forEach((e) => {
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

// Render a comment body: plain text plus fenced ```lang code blocks (highlighted).
function renderBody(body: string, fallbackLang: string | null): HTMLElement {
  const wrap = el("div", "msg-body");
  const segments = body.split("```");
  segments.forEach((seg, i) => {
    if (i % 2 === 0) {
      if (seg) wrap.append(document.createTextNode(seg));
      return;
    }
    const nl = seg.indexOf("\n");
    const first = nl >= 0 ? seg.slice(0, nl).trim() : "";
    const lang = first && /^[\w+-]+$/.test(first) ? first.toLowerCase() : null;
    const code = lang !== null ? seg.slice(nl + 1) : seg;
    const pre = el("pre", "code-block");
    const codeEl = document.createElement("code");
    codeEl.innerHTML = hl(code.replace(/\n+$/, ""), lang ?? fallbackLang);
    pre.append(codeEl);
    wrap.append(pre);
  });
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
        openCompose(row, f.path, sel.start, sel.end);
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
    if (th) for (const t of th) body.append(renderThread(t, lang));
  }
  return body;
}

function splitBody(f: FileView, lines: Line[], lang: string | null): HTMLElement {
  const body = el("div");
  const threadsByLine: Record<number, FileView["threads"]> = {};
  for (const t of f.threads) (threadsByLine[t.line] ||= []).push(t);
  let dels: Line[] = [];
  let adds: Line[] = [];
  const appendThreads = (line: number | undefined) => {
    const th = line !== undefined ? threadsByLine[line] : undefined;
    if (th) for (const t of th) body.append(renderThread(t, lang));
  };
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const a = adds[i];
      body.append(srow(dels[i], a, lang, f.path));
      appendThreads(a?.newNo);
    }
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === "hunk") {
      flush();
      body.append(el("div", "srow hunk", l.text));
    } else if (l.kind === "del") dels.push(l);
    else if (l.kind === "add") adds.push(l);
    else {
      flush();
      body.append(srow(l, l, lang, f.path));
      appendThreads(l.newNo);
    }
  }
  flush();
  return body;
}
function sideCell(
  l: Line | undefined,
  kind: "del" | "add",
  lang: string | null,
  file: string,
): HTMLElement {
  const s = el("div", `side${l ? ` ${kind}` : " empty"}`);
  if (!l) return s;
  const no = el("span", "no", String(kind === "del" ? (l.oldNo ?? "") : (l.newNo ?? "")));
  s.append(no, codeSpan(l.text, lang));
  // The new-side carries the anchor so native text-selection comments work in split.
  if (kind === "add" && l.newNo !== undefined) {
    s.dataset.file = file;
    s.dataset.line = String(l.newNo);
  }
  return s;
}
function srow(d: Line | undefined, a: Line | undefined, lang: string | null, file: string): HTMLElement {
  const r = el("div", "srow");
  const addCell = sideCell(a, "add", lang, file);
  r.append(sideCell(d, "del", lang, file), addCell);
  if (a?.newNo !== undefined) {
    const line = a.newNo;
    const gut = el("span", "sgut cm", "💬");
    gut.title = `comment on line ${line}`;
    gut.onclick = () => {
      const sel = selectionFor(file, line);
      openCompose(r, file, sel.start, sel.end);
      clearSelection();
    };
    addCell.append(gut);
  }
  return r;
}

function avatar(author: string): HTMLElement {
  const a = el("span", `avatar ${author === "agent" ? "agent" : "human"}`);
  a.textContent = author === "agent" ? "R" : "Y";
  return a;
}

function renderThread(t: FileView["threads"][number], lang: string | null): HTMLElement {
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

  for (const m of t.messages) {
    const msg = el("div", "msg");
    const head = el("div", "msg-head");
    head.append(avatar(m.author), el("span", "who", m.author === "agent" ? "revizorro" : "you"));
    msg.append(head, renderBody(m.body, lang));
    content.append(msg);
  }

  if (t.pending) {
    const loader = el("div", "loader");
    loader.append(el("span", "spinner"), document.createTextNode(" revizorro is replying…"));
    content.append(loader);
  }

  if (!t.resolved) {
    const composer = el("div", "reply-box");
    const ta = document.createElement("textarea");
    ta.rows = 1;
    ta.placeholder = "Reply…  (⌘/Ctrl+Enter reply · ⌘/Ctrl+Alt+Enter ask)";
    const replyFn = () => {
      const v = ta.value.trim();
      if (v) vscode.postMessage({ type: "reply", threadId: t.id, body: v });
      ta.value = "";
    };
    const askFn = () => {
      const v = ta.value.trim();
      if (v) vscode.postMessage({ type: "askReply", threadId: t.id, body: v });
      ta.value = "";
    };
    const reply = el("button", undefined, "Reply");
    const ask = el("button", "primary", "Ask agent");
    reply.onclick = replyFn;
    ask.onclick = askFn;
    onSubmit(ta, replyFn, askFn);
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
  snippet?: string,
): void {
  // Only one composer open at a time.
  document.querySelectorAll(".compose").forEach((e) => {
    e.remove();
  });
  const box = el("div", "compose");
  if (snippet) {
    const pre = el("pre", "snippet");
    pre.innerHTML = hl(snippet, langFor(file));
    box.append(pre);
  }
  const ta = document.createElement("textarea");
  ta.rows = 2;
  const where = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  ta.placeholder = `Comment on ${where}…  (⌘/Ctrl+Enter comment · ⌘/Ctrl+Alt+Enter ask · Esc cancel)`;
  const draftKey = `${file}:${startLine}:${endLine}`;
  ta.value = drafts.get(draftKey) ?? "";
  ta.addEventListener("input", () => {
    drafts.set(draftKey, ta.value);
  });
  // Carry the selected code into the comment so the agent sees the exact piece.
  const withSnippet = (v: string) => (snippet ? `\`\`\`\n${snippet}\n\`\`\`\n\n${v}` : v);
  const commentFn = () => {
    const v = ta.value.trim();
    if (v) vscode.postMessage({ type: "comment", file, startLine, endLine, body: withSnippet(v) });
    drafts.delete(draftKey);
    box.remove();
  };
  const askFn = () => {
    const v = ta.value.trim();
    if (v) vscode.postMessage({ type: "ask", file, startLine, endLine, body: withSnippet(v) });
    drafts.delete(draftKey);
    box.remove();
  };
  const send = el("button", undefined, "Comment");
  const ask = el("button", "primary", "Ask agent");
  const cancel = el("button", "ghost", "Cancel");
  send.onclick = commentFn;
  ask.onclick = askFn;
  cancel.onclick = () => {
    box.remove();
  };
  onSubmit(ta, commentFn, askFn);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") box.remove();
  });
  box.append(ta, send, ask, cancel);
  row.after(box);
  autoGrow(ta);
  ta.focus();
}

const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock)$/;

// Draggable divider that resizes the left/right columns of a split diff.
function splitDivider(container: HTMLElement): HTMLElement {
  const d = el("div", "split-divider");
  d.onmousedown = (e) => {
    e.preventDefault();
    d.classList.add("dragging");
    const rect = container.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const pct = Math.min(85, Math.max(15, ((ev.clientX - rect.left) / rect.width) * 100));
      container.style.setProperty("--lw", `${pct}%`);
    };
    const up = () => {
      d.classList.remove("dragging");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  return d;
}

function renderFile(f: FileView, mode: string): HTMLElement {
  const lineCount = f.patch ? f.patch.split("\n").length : 0;
  const big = LOCKFILE.test(f.path) || lineCount > 400;
  const collapsed = f.viewed || big;
  const wrap = el("div", `file${f.viewed ? " viewed" : ""}`);
  const head = el("div", "file-head");
  const caret = el("span", "caret", collapsed ? "▸" : "▾");
  const path = el("span", "path", f.path);
  const tag = el("span", "tag", f.binary ? "binary" : big ? `${lineCount} lines — collapsed` : "");
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
    const lines = parsePatch(f.patch);
    if (mode === "split") {
      diff.classList.add("split");
      diff.append(splitBody(f, lines, lang), splitDivider(diff));
    } else {
      diff.append(inlineBody(f, lines, lang));
    }
  }
  wrap.append(head, diff);
  return wrap;
}

function render(): void {
  if (!state) return;
  const round = document.getElementById("round");
  if (round) round.textContent = `round ${state.round} · ${state.status}`;
  const pendingCount = state.files.reduce(
    (n, f) => n + f.threads.filter((t) => t.pending).length,
    0,
  );
  const tl = document.getElementById("toploader");
  if (tl) tl.textContent = pendingCount > 0 ? `⏳ agent is answering ${pendingCount} question(s)…` : "";
  const root = document.getElementById("files");
  if (!root) return;
  root.innerHTML = "";
  if (!state.files.length) {
    root.append(el("div", "empty", "no changes in the worktree"));
    return;
  }
  for (const f of state.files) root.append(renderFile(f, state.viewMode || "inline"));
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

// Native text selection → floating "Comment" bubble. Select any code (part of a
// line or across lines) and a bubble offers to comment on the spanned range.
function rowOf(node: Node | null): HTMLElement | null {
  const elt = node && node.nodeType === 3 ? node.parentElement : (node as Element | null);
  return (elt?.closest(".ln, .side") as HTMLElement | null) ?? null;
}
let bubble: HTMLElement | null = null;
function clearBubble(): void {
  bubble?.remove();
  bubble = null;
}
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
  const nums = [startRow, endRow]
    .map((r) => (r?.dataset.line ? parseInt(r.dataset.line, 10) : NaN))
    .filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return;
  const startLine = Math.min(...nums);
  const endLine = Math.max(...nums);
  const snippet = selObj.toString();
  const rect = selObj.getRangeAt(0).getBoundingClientRect();
  const label = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  const b = el("button", "sel-bubble primary", `💬 Comment on ${label}`);
  b.style.top = `${rect.bottom + window.scrollY + 4}px`;
  b.style.left = `${rect.left + window.scrollX}px`;
  b.onclick = () => {
    const anchor = document.querySelector(`.ln[data-file="${CSS.escape(file)}"][data-line="${endLine}"]`);
    clearBubble();
    if (anchor instanceof HTMLElement) openCompose(anchor, file, startLine, endLine, snippet);
  };
  bubble = b;
  document.body.append(b);
});

window.addEventListener("message", (e: MessageEvent) => {
  if ((e.data as Msg).type !== "state") return;
  state = e.data as Msg;
  render();
});
