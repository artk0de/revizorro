import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionState, FileRange, Side } from "@revizorro/protocol";
import type { DiffFile } from "@revizorro/core";
import { REVIEW_TAB_ICON, reviewTabTitle } from "./review-tab.js";

/**
 * What a review tab can ask of the review it shows. Named as an interface rather
 * than typed as the host, because the tab must act on ONE review: give it the whole
 * host and every button it owns would reach whichever review happened to be last.
 */
export interface ReviewActions {
  isPending: (threadId: string) => boolean;
  branch: () => string;
  isAgentWaiting: () => boolean;
  noteActivity: () => void;
  approve: () => Promise<void>;
  requestChanges: () => Promise<void>;
  clarify: () => Promise<void>;
  abandon: () => Promise<void>;
  addHumanComment: (
    file: string,
    range: FileRange,
    body: string,
    ask?: boolean,
    side?: Side,
  ) => Promise<void>;
  addHumanReply: (threadId: string, body: string, ask?: boolean) => Promise<void>;
  editMessage: (threadId: string, index: number, body: string) => Promise<void>;
  resolveThread: (threadId: string, resolved: boolean) => Promise<void>;
  setViewed: (file: string, viewed: boolean) => Promise<void>;
}

/**
 * One review tab: the webview panel plus everything that describes what THIS tab is
 * showing — the last state posted into it, whether its diff is inline or split, and
 * whether it is closing because of a verdict or because the human walked out.
 */
export class ReviewPanel {
  private readonly panel: vscode.WebviewPanel;
  private lastMessage?: object;
  private viewMode: "inline" | "split" = "inline";
  /** Set right before a verdict disposes the panel, so onDidDispose can tell a
   *  real decision apart from the human closing the tab (which must emit closed). */
  private decided = false;

  constructor(
    /** The one review this tab shows and acts on. */
    readonly actions: ReviewActions,
    mediaDir: string,
    /** Reports the close and whether a verdict caused it — the terminal is the
     *  window's to restore, not this tab's. */
    onDisposed: (decided: boolean) => void,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "revizorroReview",
      // render() puts the round in right after; this only shows if it never can.
      "Code Review",
      vscode.ViewColumn.Active,
      // enableFindWidget gives the form VS Code's own Cmd/Ctrl+F over the rendered
      // diff — searching a long review by eye is the alternative.
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
    );
    this.panel.iconPath = {
      light: vscode.Uri.file(join(mediaDir, REVIEW_TAB_ICON.light)),
      dark: vscode.Uri.file(join(mediaDir, REVIEW_TAB_ICON.dark)),
    };
    const html = readFileSync(join(mediaDir, "review.html"), "utf8");
    const js = readFileSync(join(mediaDir, "webview.js"), "utf8").replace(
      /<\/script>/g,
      "<\\/script>",
    );
    this.panel.webview.html = html.replace("// <!--WEBVIEW_JS-->", () => js);
    this.panel.onDidDispose(() => {
      onDisposed(this.decided);
      // Tab closed without Approve/Request changes → the human abandoned the
      // review; wake any blocked agent with a closed event instead of hanging.
      if (!this.decided) void this.actions.abandon();
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
        text?: string;
      }) => {
        if (m.type === "ready") {
          if (this.lastMessage) void this.panel.webview.postMessage(this.lastMessage);
        } else if (m.type === "copy" && m.text) {
          // The webview cannot be relied on for clipboard access; the host can.
          void vscode.env.clipboard.writeText(m.text);
        } else if (m.type === "activity") {
          // Reading and scrolling emit nothing else; this is what keeps the
          // host's inactivity clock honest about a reviewer who is still here.
          this.actions.noteActivity();
        } else if (m.type === "approve") {
          this.decided = true;
          void this.actions.approve();
          this.panel.dispose();
        } else if (m.type === "requestChanges") {
          this.decided = true;
          void this.actions.requestChanges();
          this.panel.dispose();
        } else if (m.type === "clarify") {
          // Form stays open; the agent answers in-place (loaders show).
          void this.actions.clarify();
        } else if (m.type === "toggleViewMode") {
          this.viewMode = this.viewMode === "inline" ? "split" : "inline";
          if (this.lastMessage) {
            void this.panel.webview.postMessage({ ...this.lastMessage, viewMode: this.viewMode });
          }
        } else if (m.type === "setViewed" && m.file !== undefined) {
          void this.actions.setViewed(m.file, !!m.viewed);
        } else if (
          (m.type === "comment" || m.type === "ask") &&
          m.file !== undefined &&
          m.startLine !== undefined &&
          m.endLine !== undefined &&
          m.body
        ) {
          void this.actions.addHumanComment(
            m.file,
            { startLine: m.startLine, endLine: m.endLine },
            m.body,
            m.type === "ask",
            m.side ?? "new",
          );
        } else if ((m.type === "reply" || m.type === "askReply") && m.threadId && m.body) {
          void this.actions.addHumanReply(m.threadId, m.body, m.type === "askReply");
        } else if (m.type === "editMessage" && m.threadId && m.index !== undefined && m.body) {
          void this.actions.editMessage(m.threadId, m.index, m.body);
        } else if (m.type === "resolve" && m.threadId) {
          void this.actions.resolveThread(m.threadId, !!m.resolved);
        }
      },
    );
  }

  /** Whether this is the tab the human is looking at — a command acts on that one. */
  isActive(): boolean {
    return this.panel.active;
  }

  /** Show this tab and render the state into it — a fresh round is not yet decided. */
  open(state: SessionState, diff: DiffFile[]): void {
    this.decided = false;
    this.render(state, diff);
  }

  render(state: SessionState, diff: DiffFile[]): void {
    // The same panel lives across rounds, so the tab follows the round it shows.
    this.panel.title = reviewTabTitle(state.round, this.actions.branch());
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
          pending: this.actions.isPending(t.id),
          messages: t.messages,
        })),
    }));
    this.lastMessage = {
      type: "state",
      round: state.round,
      status: state.status,
      scope: state.scope,
      branch: this.actions.branch(),
      agentWaiting: this.actions.isAgentWaiting(),
      viewMode: this.viewMode,
      files,
    };
    void this.panel.webview.postMessage(this.lastMessage);
  }

  dispose(): void {
    this.panel.dispose();
  }
}
