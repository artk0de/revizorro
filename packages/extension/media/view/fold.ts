/**
 * Folds the human set by hand, kept across re-renders. Every push from the
 * extension rebuilds the form, and a card otherwise re-derives its fold from
 * `viewed` / `resolved` — closing a file someone had opened to comment on.
 * Keyed by file path and thread id; `true` means open.
 */

const folds = { file: new Map<string, boolean>(), thread: new Map<string, boolean>() };

export type FoldKind = keyof typeof folds;

/** The fold to render: what the human chose, else the card's own default. */
export function isOpen(kind: FoldKind, key: string, byDefault: boolean): boolean {
  return folds[kind].get(key) ?? byDefault;
}

/** Show or hide a fold's body, flip its caret, and remember the choice. */
export function setOpen(
  kind: FoldKind,
  key: string,
  body: HTMLElement,
  caret: HTMLElement | null,
  open: boolean,
): void {
  folds[kind].set(key, open);
  body.style.display = open ? "block" : "none";
  if (caret) caret.textContent = open ? "▾" : "▸";
}

/** Drop the choice, so the next render folds by the card's state again. */
export function forgetFold(kind: FoldKind, key: string): void {
  folds[kind].delete(key);
}

/** Test seam: forget every fold. */
export function resetFolds(): void {
  folds.file.clear();
  folds.thread.clear();
}
