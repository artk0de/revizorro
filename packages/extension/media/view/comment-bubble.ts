import { el } from "./dom.js";
import { openComposeAt } from "./thread.js";

/**
 * Native text selection → floating "Comment" bubble. Select any code (part of a
 * line or across lines) and a bubble offers to comment on the spanned range.
 */

interface SelectedRange {
  file: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
}

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
function pinSelectionSide(e: MouseEvent): void {
  document.querySelectorAll(".splitgrid").forEach((g) => {
    g.classList.remove("sel-old", "sel-new");
  });
  const cell =
    e.target instanceof Element ? e.target.closest<HTMLElement>(".gcode[data-side]") : null;
  const side = cell?.dataset.side;
  if (side) cell?.closest(".splitgrid")?.classList.add(side === "old" ? "sel-old" : "sel-new");
}

/** The diff lines a native selection spans, or null when it spans none. */
function selectedRange(selObj: Selection): SelectedRange | null {
  const startRow = rowOf(selObj.anchorNode);
  const endRow = rowOf(selObj.focusNode);
  const file = startRow?.dataset.file;
  if (!file) return null;
  // Comment on the side where the selection started (old = deleted, new = added).
  const side = (startRow?.dataset.side as "old" | "new" | undefined) ?? "new";
  const nums = [startRow, endRow]
    .map((r) => (r?.dataset.line ? parseInt(r.dataset.line, 10) : NaN))
    .filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return null;
  return { file, side, startLine: Math.min(...nums), endLine: Math.max(...nums) };
}

function showBubble(e: MouseEvent, range: SelectedRange, snippet: string): void {
  const { file, side, startLine, endLine } = range;
  const label = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  const b = el("button", "sel-bubble primary", `💬 Comment on ${label}`);
  // Anchor at the cursor where the drag ended — on the active side — instead of a
  // multi-row range rect that geometrically spans both columns (= always left).
  b.style.top = `${e.clientY + window.scrollY + 8}px`;
  b.style.left = `${e.clientX + window.scrollX}px`;
  b.onclick = () => {
    clearBubble();
    openComposeAt(file, startLine, endLine, side, snippet);
  };
  bubble = b;
  document.body.append(b);
}

function offerComment(e: MouseEvent): void {
  // Don't dismiss the bubble when the click is the bubble itself — let its
  // onclick fire (otherwise the button is unclickable).
  if (bubble && e.target instanceof Node && bubble.contains(e.target)) return;
  clearBubble();
  const selObj = window.getSelection();
  if (!selObj || selObj.isCollapsed || selObj.rangeCount === 0 || !selObj.toString().trim()) return;
  const range = selectedRange(selObj);
  if (range) showBubble(e, range, selObj.toString());
}

export function bindCommentBubble(): void {
  document.addEventListener("mousedown", pinSelectionSide);
  document.addEventListener("mouseup", offerComment);
}
