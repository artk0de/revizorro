import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionState } from "@revizorro/protocol";
import type { DiffFile } from "@revizorro/core";
import type { ReviewHost } from "./host.js";

/**
 * Self-contained webview review form (GitHub-PR-style): renders the full diff
 * with code + viewed-collapse + inline comments + Approve/Decline, all in one
 * panel. UI actions delegate to ReviewHost.
 */
export class ReviewForm {
  private panel?: vscode.WebviewPanel;
  private lastMessage?: object;
  private viewMode: "inline" | "split" = "inline";
  /** Set right before a verdict disposes the panel, so onDidDispose can tell a
   *  real decision apart from the human closing the tab (which must emit closed). */
  private decided = false;

  constructor(
    private readonly host: ReviewHost,
    private readonly mediaDir: string,
  ) {}

  /** Open (creating if needed) the form, then render the current state. */
  open(state: SessionState | null, diff: DiffFile[]): void {
    this.decided = false;
    this.ensurePanel();
    this.render(state, diff);
  }

  /** Render an update into the EXISTING panel — never resurrects a closed form. */
  render(state: SessionState | null, diff: DiffFile[]): void {
    if (!this.panel || !state) return;
    const files = diff.map((d) => ({
      path: d.path,
      oldPath: d.oldPath,
      patch: d.patch ?? "",
      content: d.content ?? "",
      binary: d.binary ?? false,
      viewed: state.files[d.path]?.viewed ?? false,
      threads: state.threads
        .filter((t) => t.file === d.path)
        .map((t) => ({
          id: t.id,
          line: t.range.startLine,
          side: t.side,
          resolved: t.resolved,
          pending: this.host.isPending(t.id),
          messages: t.messages,
        })),
    }));
    this.lastMessage = {
      type: "state",
      round: state.round,
      status: state.status,
      scope: state.scope,
      agentWaiting: this.host.isAgentWaiting(),
      viewMode: this.viewMode,
      files,
    };
    void this.panel.webview.postMessage(this.lastMessage);
  }

  private ensurePanel(): void {
    if (this.panel) return;
    this.panel = vscode.window.createWebviewPanel(
      "revizorroReview",
      "revizorro review",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const html = readFileSync(join(this.mediaDir, "review.html"), "utf8");
    const js = readFileSync(join(this.mediaDir, "webview.js"), "utf8").replace(
      /<\/script>/g,
      "<\\/script>",
    );
    this.panel.webview.html = html.replace("// <!--WEBVIEW_JS-->", () => js);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      // Tab closed without Approve/Request changes → the human abandoned the
      // review; wake any blocked agent with a closed event instead of hanging.
      if (!this.decided) void this.host.abandon();
    });
    this.panel.webview.onDidReceiveMessage(
      (m: {
        type: string;
        file?: string;
        side?: "old" | "new";
        viewed?: boolean;
        startLine?: number;
        endLine?: number;
        index?: number;
        body?: string;
        threadId?: string;
        resolved?: boolean;
      }) => {
        if (m.type === "ready") {
          if (this.lastMessage) void this.panel?.webview.postMessage(this.lastMessage);
        } else if (m.type === "activity") {
          // Reading and scrolling emit nothing else; this is what keeps the
          // host's inactivity clock honest about a reviewer who is still here.
          this.host.noteActivity();
        } else if (m.type === "approve") {
          this.decided = true;
          void this.host.approve();
          this.panel?.dispose();
        } else if (m.type === "requestChanges") {
          this.decided = true;
          void this.host.requestChanges();
          this.panel?.dispose();
        } else if (m.type === "clarify") {
          // Form stays open; the agent answers in-place (loaders show).
          void this.host.clarify();
        } else if (m.type === "toggleViewMode") {
          this.viewMode = this.viewMode === "inline" ? "split" : "inline";
          if (this.lastMessage) {
            void this.panel?.webview.postMessage({ ...this.lastMessage, viewMode: this.viewMode });
          }
        } else if (m.type === "setViewed" && m.file !== undefined) {
          void this.host.setViewed(m.file, !!m.viewed);
        } else if (
          (m.type === "comment" || m.type === "ask") &&
          m.file !== undefined &&
          m.startLine !== undefined &&
          m.endLine !== undefined &&
          m.body
        ) {
          void this.host.addHumanComment(
            m.file,
            { startLine: m.startLine, endLine: m.endLine },
            m.body,
            m.type === "ask",
            m.side ?? "new",
          );
        } else if ((m.type === "reply" || m.type === "askReply") && m.threadId && m.body) {
          void this.host.addHumanReply(m.threadId, m.body, m.type === "askReply");
        } else if (m.type === "editMessage" && m.threadId && m.index !== undefined && m.body) {
          void this.host.editMessage(m.threadId, m.index, m.body);
        } else if (m.type === "resolve" && m.threadId) {
          void this.host.resolveThread(m.threadId, !!m.resolved);
        }
      },
    );
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
