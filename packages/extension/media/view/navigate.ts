/**
 * Moving the reader around a long diff: to the next open thread, to a search
 * hit. Every jump has the same three obligations — open whatever is collapsed
 * on the way, scroll clear of the chrome pinned over the target, and leave a
 * mark so the eye lands where the click meant to send it.
 */

/** Ids of threads still open, in diff order — the DOM already holds that order. */
export function unresolvedThreadIds(): string[] {
  const open = document.querySelectorAll<HTMLElement>("#files .thread:not(.resolved)");
  return [...open].map((t) => t.dataset.id ?? "").filter(Boolean);
}

/**
 * Every thread in diff order, resolved ones included.
 *
 * This is what lets a cursor keep its place when the thread under it closes:
 * the open list alone cannot say where a just-resolved thread used to sit.
 */
export function allThreadIds(): string[] {
  const all = document.querySelectorAll<HTMLElement>("#files .thread");
  return [...all].map((t) => t.dataset.id ?? "").filter(Boolean);
}

/** The thread box carrying an id, or null once a re-render has dropped it. */
export function threadElement(id: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>("#files .thread")];
  return all.find((t) => t.dataset.id === id) ?? null;
}

/**
 * Where the next step lands.
 *
 * Stepping walks diff order — `all`, resolved threads included — and returns the
 * first thread still open. That matters most right after a resolve: finishing
 * thread 3 and pressing "next" has to reach 4, not throw the reader back to 1,
 * which is what happens if the cursor is read as "no position" the moment its
 * thread leaves the open list.
 */
export function stepId(
  ids: string[],
  current: string | null,
  dir: 1 | -1,
  all: string[] = ids,
): string | null {
  if (ids.length === 0) return null;
  const from = current === null ? -1 : all.indexOf(current);
  // A cursor the page has never heard of (a thread dropped by a re-render) has no
  // place to walk from, so start at the near end.
  if (from < 0) return dir === 1 ? ids[0] : ids[ids.length - 1];

  const open = new Set(ids);
  const n = all.length;
  for (let i = 1; i <= n; i++) {
    const id = all[(((from + dir * i) % n) + n) % n];
    if (open.has(id)) return id;
  }
  return null;
}

/** Same wrap-around walk over a plain count; -1 means "nowhere yet". */
export function stepIndex(len: number, current: number, dir: 1 | -1): number {
  if (len === 0) return -1;
  if (current < 0) return dir === 1 ? 0 : len - 1;
  return (current + dir + len) % len;
}

/**
 * Paint the thread walker: position among the open threads, or nothing at all.
 * A review with everything resolved has nothing to walk, and a control reading
 * 0/0 is chrome that invites a click and then does nothing.
 */
export function renderThreadNav(
  ids: string[],
  current: string | null,
  all: string[] = ids,
): void {
  const nav = document.getElementById("threadNav");
  if (!nav) return;
  nav.toggleAttribute("hidden", ids.length === 0);
  const pos = document.getElementById("threadPos");
  if (!pos) return;
  if (ids.length === 0) {
    pos.textContent = "";
    return;
  }
  pos.textContent = `${position(ids, current, all)}/${ids.length}`;
  pos.title = `${ids.length} unresolved thread(s)`;
}

/**
 * Which of the open threads the cursor stands on — counting from 1, or 0 before
 * the reader has moved at all.
 *
 * When the thread under the cursor has just been resolved it is no longer in the
 * open list, but the reader has not gone anywhere: the answer is how many open
 * threads sit at or above its place in diff order. Reporting 0 there is what made
 * the counter lurch back to the top the moment a thread was ticked off.
 */
function position(ids: string[], current: string | null, all: string[]): number {
  if (current === null) return 0;
  const at = ids.indexOf(current);
  if (at >= 0) return at + 1;
  const stood = all.indexOf(current);
  if (stood < 0) return 0;
  return ids.filter((id) => all.indexOf(id) < stood).length;
}

/** Room the sticky toolbar and the pinned file header take off the top. */
function chromeHeight(card: HTMLElement | null): number {
  const bar = document.querySelector<HTMLElement>(".toolbar");
  const head = card?.querySelector<HTMLElement>(".file-head") ?? null;
  const barH = bar?.getBoundingClientRect().height ?? 0;
  const headH = head?.getBoundingClientRect().height ?? 0;
  return barH + headH + 8;
}

/** Take the flash off whatever carried it last, so only one place is lit. */
function flash(target: HTMLElement): void {
  for (const prev of document.querySelectorAll(".jump-flash")) prev.classList.remove("jump-flash");
  target.classList.add("jump-flash");
}

/** Reveal, scroll to, and mark a target anywhere in the diff. */
export function jumpTo(target: HTMLElement): void {
  const card = target.closest<HTMLElement>(".file[data-path]");
  // A viewed or oversized file renders collapsed, and a resolved thread renders
  // folded. Landing on either shows the human a closed box and reads as a no-op.
  const diff = card?.querySelector<HTMLElement>(".diff");
  if (diff?.style.display === "none") {
    diff.style.display = "block";
    const caret = card?.querySelector<HTMLElement>(".caret");
    if (caret) caret.textContent = "▾";
  }
  if (target.classList.contains("thread")) {
    const content = target.querySelector<HTMLElement>(".thread-content");
    if (content?.style.display === "none") {
      content.style.display = "block";
      const caret = target.querySelector<HTMLElement>(".tcaret");
      if (caret) caret.textContent = "▾";
    }
  }
  const top = target.getBoundingClientRect().top + (window.scrollY || 0) - chromeHeight(card);
  window.scrollTo?.({ top: Math.max(0, top), behavior: "smooth" });
  flash(target);
}
