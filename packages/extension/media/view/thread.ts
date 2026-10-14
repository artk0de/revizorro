import { composeDraftKey, replyDraftKey, editDraftKey } from "@revizorro/core";
import { langFor, hl, renderMarkdown } from "./highlight.js";
import { el, onSubmit, autoGrow } from "./dom.js";
import { send } from "./bridge.js";
import { bindDraft, clearDraft, markEditorOpen, markEditorClosed, isEditorOpen } from "./drafts.js";

/**
 * A comment thread under a diff line, and the composer that starts one.
 *
 * Both are rebuilt from scratch on every agent push; what the human was typing
 * survives through {@link bindDraft}, and an open composer through
 * {@link reopenCompose}.
 */

export interface ThreadMessage {
  author: string;
  body: string;
}

export interface ThreadView {
  id: string;
  line: number;
  side: "old" | "new";
  resolved: boolean;
  pending: boolean;
  messages: ThreadMessage[];
}

interface ComposeAnchor {
  file: string;
  startLine: number;
  endLine: number;
  side: "old" | "new";
  snippet?: string;
}

// The composer currently open, if any. An incoming agent reply re-renders the
// whole form; this lets render() reopen the composer (with its draft) instead of
// silently dropping what the human was typing.
let activeCompose: ComposeAnchor | null = null;

function renderBody(body: string): HTMLElement {
  const wrap = el("div", "msg-body");
  wrap.innerHTML = renderMarkdown(body);
  return wrap;
}

function avatar(author: string): HTMLElement {
  const a = el("span", `avatar ${author === "agent" ? "agent" : "human"}`);
  a.textContent = author === "agent" ? "R" : "Y";
  return a;
}

function threadBar(t: ThreadView): { bar: HTMLElement; caret: HTMLElement } {
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
  return { bar, caret };
}

/** Swap a posted message's body for an editor; returns the opener. */
function messageEditor(
  t: ThreadView,
  m: ThreadMessage,
  i: number,
  msg: HTMLElement,
  bodyEl: HTMLElement,
): () => void {
  const editKey = editDraftKey(t.id, i);
  return () => {
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
}

/**
 * One message of a thread. Your own posts in an unresolved thread get a pencil;
 * their editor openers are collected into `editFns` for the reply box's ↑ hotkey.
 */
function renderMessage(
  t: ThreadView,
  m: ThreadMessage,
  i: number,
  editFns: (() => void)[],
): HTMLElement {
  // The first message is the root comment; everything after is a reply —
  // indent replies under a left rail so the conversation reads as a thread.
  const msg = el("div", i === 0 ? "msg" : "msg reply");
  const head = el("div", "msg-head");
  head.append(avatar(m.author), el("span", "who", m.author === "agent" ? "revizorro" : "you"));
  const bodyEl = renderBody(m.body);
  const startEdit = messageEditor(t, m, i, msg, bodyEl);
  if (m.author === "human" && !t.resolved) {
    editFns.push(startEdit);
    const edit = el("button", "ghost icon-edit", "✏️");
    edit.title = "Edit (↑)";
    edit.onclick = startEdit;
    head.append(el("span", "grow"), edit);
  }
  msg.append(head, bodyEl);
  // This message was being edited when the form re-rendered — reopen the editor
  // so the human keeps typing where they left off.
  if (isEditorOpen(editDraftKey(t.id, i))) queueMicrotask(startEdit);
  return msg;
}

function pendingLoader(): HTMLElement {
  const loader = el("div", "loader");
  loader.append(el("span", "spinner"), document.createTextNode(" revizorro is replying…"));
  return loader;
}

function replyBox(t: ThreadView, editFns: (() => void)[]): HTMLElement {
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
  return composer;
}

export function renderThread(t: ThreadView): HTMLElement {
  const box = el("div", `thread${t.resolved ? " resolved" : ""}`);
  // Thread navigation keeps its place across re-renders by id, not by position:
  // an agent reply arriving mid-walk must not shift the human somewhere else.
  box.dataset.id = t.id;
  const { bar, caret } = threadBar(t);
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
    content.append(renderMessage(t, m, i, editFns));
  });
  if (t.pending) content.append(pendingLoader());
  if (!t.resolved) content.append(replyBox(t, editFns));
  box.append(content);
  return box;
}

function composeActions(
  ta: HTMLTextAreaElement,
  at: ComposeAnchor,
  draftKey: string,
  close: () => void,
): HTMLElement {
  const { file, side, startLine, endLine, snippet } = at;
  // Carry the selected code into the comment so the agent sees the exact piece.
  const withSnippet = (v: string) => (snippet ? `\`\`\`\n${snippet}\n\`\`\`\n\n${v}` : v);
  const post = (type: "comment" | "ask") => {
    const v = ta.value.trim();
    if (v) send({ type, file, side, startLine, endLine, body: withSnippet(v) });
    clearDraft(draftKey);
    close();
  };
  const commentFn = () => {
    post("comment");
  };
  const askFn = () => {
    post("ask");
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
  return actions;
}

export function openCompose(
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
  const at: ComposeAnchor = { file, startLine, endLine, side, snippet };
  activeCompose = at;
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
  const close = () => {
    activeCompose = null;
    box.remove();
  };
  box.append(ta, composeActions(ta, at, draftKey, close));
  // In split, anchor the composer after the line's grid row so it spans full
  // width as its own grid item; in inline it just follows the clicked line.
  const block = row.closest(".srow") ?? row;
  block.after(box);
  autoGrow(ta);
  ta.focus();
}

/**
 * Open a composer on a range by its line anchor in the rendered diff — the
 * side-specific anchor first, then any anchor on that line. No anchor, no-op.
 */
export function openComposeAt(
  file: string,
  startLine: number,
  endLine: number,
  side: "old" | "new",
  snippet?: string,
): void {
  const anchor =
    document.querySelector(
      `[data-side="${side}"][data-file="${CSS.escape(file)}"][data-line="${endLine}"]`,
    ) ?? document.querySelector(`[data-file="${CSS.escape(file)}"][data-line="${endLine}"]`);
  if (anchor instanceof HTMLElement) openCompose(anchor, file, startLine, endLine, side, snippet);
}

/**
 * Reopen the composer the human had open before a re-render (e.g. an agent
 * reply landed mid-typing) so their in-progress comment survives.
 */
export function reopenCompose(): void {
  if (!activeCompose) return;
  const { file, startLine, endLine, side, snippet } = activeCompose;
  openComposeAt(file, startLine, endLine, side, snippet);
}
