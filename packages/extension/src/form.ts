import * as vscode from "vscode";
import type { SessionState } from "@revizorro/protocol";
import type { DiffFile } from "@revizorro/core";
import type { ReviewHost } from "./host.js";
import { ReviewPanel } from "./panel.js";

/**
 * The window's review tabs: opens them, renders into them, and owns the one piece of
 * state that belongs to the window rather than to any single tab — whether the
 * terminal was pushed aside to give a review the full height.
 */
export class ReviewForm {
  private panel?: ReviewPanel;

  constructor(
    private readonly host: ReviewHost,
    private readonly mediaDir: string,
  ) {}

  /** Open (creating if needed) the form, then render the current state. */
  open(state: SessionState | null, diff: DiffFile[]): void {
    const panel = this.ensurePanel();
    if (!state) return;
    panel.open(state, diff);
  }

  /** Render an update into the EXISTING panel — never resurrects a closed form. */
  render(state: SessionState | null, diff: DiffFile[]): void {
    if (!this.panel || !state) return;
    this.panel.render(state, diff);
  }

  private ensurePanel(): ReviewPanel {
    const open = this.panel;
    if (open) return open;
    const panel = new ReviewPanel(this.host, this.mediaDir, (decided) => {
      this.panel = undefined;
      // A verdict hands the work back to the agent, and the terminal is where the
      // human watches it pick the work up.
      if (decided) this.restoreTerminal();
    });
    this.panel = panel;
    // Created, not rendered: a re-render must never slam shut a terminal the human
    // deliberately opened while reading.
    this.collapseTerminal();
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
    this.panel?.dispose();
  }
}
