import { fileReviewState } from "@revizorro/core";
import { el } from "./dom.js";
import { diffStat } from "./patch.js";

/** What the toolbar needs to know about one file. */
export interface SummaryFile {
  patch: string;
  binary: boolean;
  viewed: boolean;
  threads: { resolved: boolean }[];
}

export interface ReviewScopeView {
  stagedOnly: boolean;
  baseRef: string;
}

/** Human-readable name for what this round is reviewing. */
export function scopeLabel(scope: ReviewScopeView | undefined): string {
  if (scope?.stagedOnly) return "staged only";
  return `branch vs ${scope?.baseRef || "default branch"}`;
}

/** Totals across the diff: files, added and removed lines. */
export function changeTotals(files: SummaryFile[]): { files: number; add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const f of files) {
    if (f.binary) continue;
    const d = diffStat(f.patch);
    add += d.add;
    del += d.del;
  }
  return { files: files.length, add, del };
}

/**
 * How far the human has got. "Done" matches the file tree: viewed AND nothing
 * unresolved left on it, so the toolbar and the sidebar never disagree.
 */
export function reviewProgress(files: SummaryFile[]): { done: number; total: number; pct: number } {
  const done = files.filter((f) => !fileReviewState(f.threads, f.viewed).needsAttention).length;
  return {
    done,
    total: files.length,
    pct: files.length > 0 ? Math.round((done / files.length) * 100) : 0,
  };
}

/** Paint the toolbar: what is under review, how big it is, how much is done. */
export function renderSummary(files: SummaryFile[], scope: ReviewScopeView | undefined): void {
  const scopeEl = document.getElementById("scope");
  if (scopeEl) {
    scopeEl.textContent = scopeLabel(scope);
    scopeEl.title = scope?.stagedOnly
      ? "reviewing the staged change against HEAD"
      : `reviewing the branch against ${scope?.baseRef || "its target branch"}`;
  }

  const totals = changeTotals(files);
  const stats = document.getElementById("stats");
  if (stats) {
    stats.innerHTML = "";
    stats.append(
      el("span", undefined, `${totals.files} file${totals.files === 1 ? "" : "s"} `),
      el("span", "add", `+${totals.add}`),
      document.createTextNode(" "),
      el("span", "del", `−${totals.del}`),
    );
  }

  const progress = reviewProgress(files);
  const label = document.getElementById("progressLabel");
  if (label) label.textContent = `${progress.done}/${progress.total} reviewed`;
  const bar = document.getElementById("progressBar");
  if (bar) {
    bar.style.width = `${progress.pct}%`;
    bar.classList.toggle("full", progress.done === progress.total && progress.total > 0);
  }
  const wrap = document.getElementById("progress");
  if (wrap) {
    wrap.style.display = progress.total > 0 ? "flex" : "none";
    wrap.title = `${progress.done} of ${progress.total} files reviewed (viewed, no unresolved threads)`;
  }
}
