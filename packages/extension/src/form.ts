import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionState } from "@revizorro/protocol";
import type { ReviewHost } from "./host.js";

type DiffViewMode = "split" | "inline";

/**
 * The review form: a CommentController renders line-anchored threads on the diff,
 * and a webview panel lists files (viewed-collapse) with Approve/Decline + a
 * view-mode toggle. UI actions delegate to the ReviewHost emit* methods.
 */
export class ReviewForm {
  private readonly comments: vscode.CommentController;
  private panel?: vscode.WebviewPanel;
  private viewMode: DiffViewMode = "inline";
  private threads: vscode.CommentThread[] = [];

  constructor(
    private readonly host: ReviewHost,
    private readonly repoRoot: string,
    private readonly mediaDir: string,
  ) {
    this.comments = vscode.comments.createCommentController("revizorro", "revizorro review");
    this.comments.commentingRangeProvider = {
      provideCommentingRanges: (doc) => [new vscode.Range(0, 0, doc.lineCount - 1, 0)],
    };
  }

  toggleViewMode(): void {
    this.viewMode = this.viewMode === "inline" ? "split" : "inline";
    if (this.panel) this.render(this.lastState);
  }

  private lastState: SessionState | null = null;

  render(state: SessionState | null): void {
    this.lastState = state;
    this.ensurePanel();
    this.renderThreads(state);
    if (this.panel && state) {
      this.panel.webview.postMessage({ type: "state", state, viewMode: this.viewMode });
    }
  }

  private renderThreads(state: SessionState | null): void {
    for (const t of this.threads) t.dispose();
    this.threads = [];
    if (!state) return;
    for (const thread of state.threads) {
      const uri = vscode.Uri.file(join(this.repoRoot, thread.file));
      const range = new vscode.Range(thread.range.startLine, 0, thread.range.endLine, 0);
      const vsThread = this.comments.createCommentThread(
        uri,
        range,
        thread.messages.map((m) => ({
          body: new vscode.MarkdownString(m.body),
          mode: vscode.CommentMode.Preview,
          author: { name: m.author === "agent" ? "revizorro (agent)" : "you" },
        })),
      );
      vsThread.label = thread.resolved ? "resolved" : undefined;
      this.threads.push(vsThread);
    }
  }

  private ensurePanel(): void {
    if (this.panel) return;
    this.panel = vscode.window.createWebviewPanel(
      "revizorroReview",
      "revizorro review",
      vscode.ViewColumn.Beside,
      { enableScripts: true },
    );
    this.panel.webview.html = readFileSync(join(this.mediaDir, "review.html"), "utf8");
    this.panel.onDidDispose(() => (this.panel = undefined));
    this.panel.webview.onDidReceiveMessage((msg: { type: string; file?: string }) => {
      if (msg.type === "approve") this.host.approve();
      else if (msg.type === "decline") void this.host.decline();
      else if (msg.type === "toggleViewMode") this.toggleViewMode();
    });
  }

  dispose(): void {
    for (const t of this.threads) t.dispose();
    this.comments.dispose();
    this.panel?.dispose();
  }
}
