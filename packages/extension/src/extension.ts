import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { registerHost, unregisterHost } from "@revizorro/core-adapters";
import { ReviewHost } from "./host.js";
import { ReviewForm } from "./form.js";

let host: ReviewHost | undefined;
let form: ReviewForm | undefined;
let hostPort: number | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The window's own project is only a PREFERENCE hint for the CLI's host picker —
  // the host reviews whatever repoRoot a `review` call targets, so it must run even
  // in a non-git or unrelated window (the agent may drive it from another terminal).
  const folder = vscode.workspace.workspaceFolders?.[0];
  let project = "";
  if (folder) {
    try {
      project = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: folder.uri.fsPath,
        encoding: "utf8",
      }).trim();
    } catch {
      // not a git repo — this window can still serve reviews for other projects
    }
  }
  const mediaDir = join(context.extensionPath, "media");

  host = new ReviewHost(
    (state, diff) => form?.render(state, diff),
    (state, diff) => form?.open(state, diff),
  );
  form = new ReviewForm(host, mediaDir);
  hostPort = await host.start();
  registerHost(hostPort, project);

  // A reload is not the end of a review. If this window's project still has a round
  // open, put the form back: the panel is the human's only way to answer, and only
  // the agent can ask for it to be opened again. Deliberately not awaited — a git
  // diff must not hold up activation, and a failure here must not break the window.
  if (project) void host.restore(project).catch(() => undefined);

  context.subscriptions.push(
    {
      dispose: () => {
        if (hostPort !== undefined) unregisterHost(hostPort);
      },
    },
    // VS Code rehydrates a panel as an empty shell with no round behind it, so its
    // restore is worse than none. Drop it; `host.restore` above puts a real form
    // back when — and only when — there is an open round to show.
    vscode.window.registerWebviewPanelSerializer("revizorroReview", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel): Thenable<void> {
        panel.dispose();
        return Promise.resolve();
      },
    }),
    vscode.commands.registerCommand("revizorro.approve", () => host?.approve()),
    vscode.commands.registerCommand("revizorro.requestChanges", () => void host?.requestChanges()),
    vscode.commands.registerCommand("revizorro.clarify", () => void host?.clarify()),
    { dispose: () => void host?.stop() },
    { dispose: () => form?.dispose() },
  );
}

export function deactivate(): void {
  if (hostPort !== undefined) unregisterHost(hostPort);
  void host?.stop();
  form?.dispose();
}
