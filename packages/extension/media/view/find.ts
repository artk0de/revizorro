/**
 * In-page search over the rendered review. The host's own find widget never
 * surfaced in this webview, and a review too long to search by eye is exactly
 * the review that needs searching — so the form carries its own.
 *
 * Matching is literal, not regex: reviewers search for `a.b` meaning `a.b`.
 */

/** Text the human is editing, or markup with no readable text of its own. */
const SKIP = new Set(["TEXTAREA", "INPUT", "SCRIPT", "STYLE"]);

const HIT = "find-hit";

/** Drop every highlight and glue the split text back together. */
export function clearMarks(root: ParentNode): void {
  const marks = [...(root as Element).querySelectorAll<HTMLElement>(`mark.${HIT}`)];
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
    (parent as Element).normalize?.();
  }
}

/** Whether the search bar is up. Read off the DOM, so a re-render cannot desync it. */
export function isFindOpen(): boolean {
  const bar = document.getElementById("findbar");
  return !!bar && !bar.hasAttribute("hidden");
}

/**
 * Summon or dismiss the search bar. It is a panel, not toolbar furniture: on a
 * narrow window a permanent input crowds out the decision buttons, and most of
 * a review is spent not searching.
 *
 * Closing throws the query and the highlights away — leaving a stale trail lit
 * behind a hidden bar means the next Enter steps through matches nothing on
 * screen explains.
 */
export function setFindOpen(open: boolean): void {
  const bar = document.getElementById("findbar");
  if (!bar) return;
  bar.toggleAttribute("hidden", !open);
  document.getElementById("findToggle")?.classList.toggle("on", open);
  const input = document.getElementById("findInput");
  if (open) {
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
    return;
  }
  if (input instanceof HTMLInputElement) input.value = "";
  const files = document.getElementById("files");
  if (files) clearMarks(files);
  const pos = document.getElementById("findPos");
  if (pos) pos.textContent = "";
}

/** Split one text node around a needle, returning the marks it produced. */
function wrapIn(node: Text, needle: string): HTMLElement[] {
  const text = node.nodeValue ?? "";
  const lower = text.toLowerCase();
  const out: HTMLElement[] = [];
  const frag = document.createDocumentFragment();
  let at = 0;
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
    if (i > at) frag.append(document.createTextNode(text.slice(at, i)));
    const mark = document.createElement("mark");
    mark.className = HIT;
    mark.textContent = text.slice(i, i + needle.length);
    frag.append(mark);
    out.push(mark);
    at = i + needle.length;
  }
  if (at < text.length) frag.append(document.createTextNode(text.slice(at)));
  node.parentNode?.replaceChild(frag, node);
  return out;
}

/**
 * Highlight every occurrence and hand back the marks in reading order. A single
 * character matches most of a diff, which is noise rather than a search, so the
 * query has to be worth at least two.
 */
export function markMatches(root: ParentNode, query: string): HTMLElement[] {
  clearMarks(root);
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (!parent || SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return (node.nodeValue ?? "").toLowerCase().includes(needle)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  // Collect first: rewriting a text node mid-walk invalidates the walker.
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text);

  const hits: HTMLElement[] = [];
  for (const t of targets) hits.push(...wrapIn(t, needle));
  return hits;
}
