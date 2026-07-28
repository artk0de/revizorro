/**
 * Text the human has typed but not sent.
 *
 * Every agent push re-renders the form from scratch, destroying the DOM being
 * typed into. Drafts live here instead, keyed by {@link composeDraftKey} and
 * friends, and are restored into the rebuilt DOM afterwards.
 */
const drafts = new Map<string, string>();

/** Message editors that were open, so a re-render can reopen them mid-edit. */
const openEditors = new Set<string>();

export function getDraft(key: string): string | undefined {
  return drafts.get(key);
}

export function setDraft(key: string, value: string): void {
  if (value) drafts.set(key, value);
  else drafts.delete(key);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}

export function markEditorOpen(key: string): void {
  openEditors.add(key);
}

export function markEditorClosed(key: string): void {
  openEditors.delete(key);
  drafts.delete(key);
}

export function isEditorOpen(key: string): boolean {
  return openEditors.has(key);
}

/** Wire a textarea to its draft: restore what was typed, then record every keystroke. */
export function bindDraft(ta: HTMLTextAreaElement, draftKey: string): void {
  ta.dataset.draftKey = draftKey;
  const saved = getDraft(draftKey);
  if (saved !== undefined) ta.value = saved;
  ta.addEventListener("input", () => {
    setDraft(draftKey, ta.value);
  });
}

export interface FocusSnapshot {
  key: string;
  start: number;
  end: number;
}

/** Where the caret was, so an arriving reply does not interrupt a sentence. */
export function focusSnapshot(): FocusSnapshot | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLTextAreaElement) || !active.dataset.draftKey) return null;
  return {
    key: active.dataset.draftKey,
    start: active.selectionStart ?? 0,
    end: active.selectionEnd ?? 0,
  };
}

export function restoreFocus(snap: FocusSnapshot | null): void {
  if (!snap) return;
  // Matched by attribute value rather than a built selector: draft keys carry JSON
  // (quotes, brackets), which a selector would need escaping for.
  const fields = document.querySelectorAll<HTMLTextAreaElement>("textarea[data-draft-key]");
  for (const field of fields) {
    if (field.dataset.draftKey !== snap.key) continue;
    field.focus();
    field.setSelectionRange(snap.start, snap.end);
    return;
  }
}

/** Test seam: drop all remembered text. */
export function resetDrafts(): void {
  drafts.clear();
  openEditors.clear();
}
