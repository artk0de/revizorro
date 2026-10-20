import { el } from "./dom.js";
import { send } from "./bridge.js";
import { LOCKFILE } from "./patch.js";
import { renderDiffBody, type DiffFile } from "./diff-body.js";
import { forgetFold, isOpen, setOpen } from "./fold.js";

/**
 * One file's card in the review: a header that names it (and what it was
 * renamed from), a viewed tick, and its diff — collapsed when already viewed
 * or too big to be worth reading inline.
 */

export interface CardFile extends DiffFile {
  /** Set when git detected a rename — the path this file used to live at. */
  oldPath?: string;
  binary: boolean;
  viewed: boolean;
}

const baseName = (path: string): string => path.split("/").pop() ?? path;

// A moved file keeps its name, a renamed one doesn't — GitLab/GitHub label the two
// differently, and the distinction is what tells you whether to re-read the diff.
function renamePath(f: CardFile): { label: HTMLElement; tag: string } {
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

export function renderFile(f: CardFile, mode: string): HTMLElement {
  const lineCount = f.patch ? f.patch.split("\n").length : 0;
  const big = LOCKFILE.test(f.path) || lineCount > 400;
  const collapsed = !isOpen("file", f.path, !(f.viewed || big));
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
    forgetFold("file", f.path);
    send({ type: "setViewed", file: f.path, viewed: cbox.checked });
  };
  chk.append(cbox, document.createTextNode(" viewed"));
  head.append(caret, path, tag, chk);

  const diff = el("div", "diff");
  diff.style.display = collapsed ? "none" : "block";
  head.onclick = () => {
    setOpen("file", f.path, diff, caret, diff.style.display === "none");
  };
  if (f.binary) diff.append(el("div", "binary", "(binary file — no textual diff)"));
  else {
    if (mode === "split") diff.classList.add("split");
    diff.append(renderDiffBody(f, mode));
  }
  wrap.append(head, diff);
  return wrap;
}

/**
 * Stand-in card for a file whose diff threw while rendering, so the tree still
 * points at something and the error is on screen rather than lost.
 */
export function renderFailedFile(path: string, e: unknown): HTMLElement {
  const failed = el("div", "file");
  failed.dataset.path = path;
  const head = el("div", "file-head");
  head.append(el("span", "path", path), el("span", "tag", "could not be rendered"));
  failed.append(head, el("div", "binary", String(e instanceof Error ? e.message : e)));
  return failed;
}
