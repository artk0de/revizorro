import { hl } from "./highlight.js";

export function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** One highlighted code span. Highlighting is HTML, hence innerHTML over textContent. */
export function codeSpan(text: string, lang: string | null): HTMLElement {
  const s = document.createElement("span");
  s.className = "txt";
  s.innerHTML = hl(text, lang);
  return s;
}

/** Cmd/Ctrl+Enter → primary (save); Cmd/Ctrl+Alt+Enter → ask agent. */
export function onSubmit(ta: HTMLTextAreaElement, primary: () => void, ask: () => void): void {
  ta.onkeydown = (e) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    (e.altKey ? ask : primary)();
  };
}

/** Grow a textarea to fit its content, so multi-line comments expand as you type. */
export function autoGrow(ta: HTMLTextAreaElement): void {
  const grow = (): void => {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  ta.addEventListener("input", grow);
  queueMicrotask(grow);
}
