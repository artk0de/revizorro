import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import cssLang from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", cssLang);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);

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
    if (th) for (const t of th) body.append(renderThread(t));
  }
  return body;
}

function splitBody(lines: Line[], lang: string | null): HTMLElement {
  const body = el("div");
  let dels: Line[] = [];
  let adds: Line[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) body.append(srow(dels[i], adds[i], lang));
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
      body.append(srow(l, l, lang));
    }
  }
  flush();
  return body;
}
function sideCell(l: Line | undefined, kind: "del" | "add", lang: string | null): HTMLElement {
  const s = el("div", `side${l ? ` ${kind}` : " empty"}`);
  if (!l) return s;
  const no = el("span", "no", String(kind === "del" ? (l.oldNo ?? "") : (l.newNo ?? "")));
  s.append(no, codeSpan(l.text, lang));
  return s;
}
function srow(d: Line | undefined, a: Line | undefined, lang: string | null): HTMLElement {
  const r = el("div", "srow");
  r.append(sideCell(d, "del", lang), sideCell(a, "add", lang));
  return r;
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

  for (const m of t.messages) {
    const msg = el("div", "msg");
    const head = el("div", "msg-head");
    head.append(avatar(m.author), el("span", "who", m.author === "agent" ? "revizorro" : "you"));
    msg.append(head, el("div", "msg-body", m.body));
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
    composer.append(ta, reply, ask);
    content.append(composer);
  }
  box.append(content);
  return box;
}

function openCompose(row: HTMLElement, file: string, startLine: number, endLine: number): void {
  const box = el("div", "compose");
  const ta = document.createElement("textarea");
  ta.rows = 2;
  const where = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  ta.placeholder = `Comment on ${where}…  (⌘/Ctrl+Enter comment · ⌘/Ctrl+Alt+Enter ask)`;
  const commentFn = () => {
    const v = ta.value.trim();
    if (v) vscode.postMessage({ type: "comment", file, startLine, endLine, body: v });
    box.remove();
  };
  const askFn = () => {
    const v = ta.value.trim();
    if (v) vscode.postMessage({ type: "ask", file, startLine, endLine, body: v });
    box.remove();
  };
  const send = el("button", undefined, "Comment");
  const ask = el("button", "primary", "Ask agent");
  send.onclick = commentFn;
  ask.onclick = askFn;
  onSubmit(ta, commentFn, askFn);
  box.append(ta, send, ask);
  row.after(box);
  ta.focus();
}

const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock)$/;

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
    diff.append(mode === "split" ? splitBody(lines, lang) : inlineBody(f, lines, lang));
  }
  wrap.append(head, diff);
  return wrap;
}

function render(): void {
  if (!state) return;
  const round = document.getElementById("round");
  if (round) round.textContent = `round ${state.round} · ${state.status}`;
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
bindButton("decline", "decline");
bindButton("toggle", "toggleViewMode");

window.addEventListener("message", (e: MessageEvent) => {
  if ((e.data as Msg).type !== "state") return;
  state = e.data as Msg;
  render();
});
