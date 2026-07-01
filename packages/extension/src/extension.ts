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

  context.subscriptions.push(
    {
      dispose: () => {
        if (hostPort !== undefined) unregisterHost(hostPort);
      },
    },
    // The form is ephemeral: it must appear only when the loop starts a review,
    // never get restored by VS Code on window reload. Drop any rehydrated panel.
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
