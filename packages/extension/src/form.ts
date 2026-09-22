import * as vscode from "vscode";
import type { SessionState } from "@revizorro/protocol";
import type { DiffFile } from "@revizorro/core";
import type { ReviewSession } from "./session.js";
import { ReviewPanel, type ReviewActions } from "./panel.js";

/**
 * The window's review tabs — one per worktree, so two agent sessions each get their
 * own — plus the one piece of state that belongs to the window rather than to any
 * single tab: whether the terminal was pushed aside to give a review the full height.
 */
export class ReviewForm {
  private readonly panels = new Map<string, ReviewPanel>();

  constructor(private readonly mediaDir: string) {}

  /** Open (creating if needed) this review's tab, then render the current state. */
  open(session: ReviewSession, state: SessionState | null, diff: DiffFile[]): void {
    const panel = this.ensurePanel(session);
    if (!state) return;
    panel.open(state, diff);
  }

  /** Render an update into the EXISTING tab — never resurrects a closed form. */
  render(session: ReviewSession, state: SessionState | null, diff: DiffFile[]): void {
    if (!state) return;
    this.panels.get(session.worktreeId)?.render(state, diff);
  }

  /**
   * The review a command from the palette should act on: the tab the human is looking
   * at. With one tab open it is that one even when the focus sits in an editor —
   * otherwise the commands would stop working the moment someone clicked away. With
   * several open and none focused there is no answer, and guessing would approve the
   * wrong branch.
   */
  activeReview(): ReviewActions | undefined {
    const panels = [...this.panels.values()];
    const active = panels.find((p) => p.isActive());
    if (active) return active.actions;
    return panels.length === 1 ? panels[0].actions : undefined;
  }

  private ensurePanel(session: ReviewSession): ReviewPanel {
    const open = this.panels.get(session.worktreeId);
    if (open) return open;
    // Created, not rendered: a re-render must never slam shut a terminal the human
    // deliberately opened while reading. Only the FIRST tab collapses it — the second
    // review opening is not a fresh reason to take the panel away again.
    const first = this.panels.size === 0;
    const panel = new ReviewPanel(session, this.mediaDir, (decided) => {
      this.panels.delete(session.worktreeId);
      // A verdict hands the work back to the agent, and the terminal is where the
      // human watches it pick the work up — but only once no review is left to read.
      if (decided && this.panels.size === 0) this.restoreTerminal();
    });
    this.panels.set(session.worktreeId, panel);
    if (first) this.collapseTerminal();
    return panel;
  }

  /**
   * Give the diff the window's full height while a human reads it.
   *
   * The terminal the agent runs in is the biggest thing competing for that height,
   * and it has nothing to say until the review is answered. Scoped to one window by
   * construction: every VS Code window runs its own extension host, so this reaches
   * only the workbench the form opened in — which is not always the window the human
   * was last looking at.
   */
  private collapseTerminal(): void {
    // Only when a terminal is actually open. The panel also carries Problems and
    // Output, and closing it on someone reading those is a theft, not a favour.
    if (vscode.window.terminals.length === 0) return;
    void vscode.commands.executeCommand("workbench.action.closePanel");
  }

  /**
   * Bring the terminal back, without conjuring one that never existed.
   *
   * This restores whenever a terminal exists, which is not quite "restore it if it
   * was on screen before" — VS Code exposes no read of panel visibility. The
   * internal `panelVisible` context key is usable only from `when` clauses in
   * package.json, and a WebviewView's own `visible` reports that VIEW, not the
   * container, so a panel sitting on the Terminal tab would report hidden. Tracked
   * upstream as microsoft/vscode#321409; when that lands, gate this on the real
   * pre-review state.
   */
  private restoreTerminal(): void {
    if (vscode.window.terminals.length === 0) return;
    void vscode.commands.executeCommand("workbench.action.terminal.focus");
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
