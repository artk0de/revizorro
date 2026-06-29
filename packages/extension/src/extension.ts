import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ReviewHost } from "./host.js";
import { ReviewForm } from "./form.js";

let host: ReviewHost | undefined;
let form: ReviewForm | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: folder.uri.fsPath,
    encoding: "utf8",
  }).trim();
  const worktreeId = createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
  const mediaDir = join(context.extensionPath, "media");

  host = new ReviewHost(repoRoot, worktreeId, (state) => form?.render(state));
  form = new ReviewForm(host, repoRoot, mediaDir);
  await host.start();

  context.subscriptions.push(
    vscode.commands.registerCommand("revizorro.approve", () => host?.approve()),
    vscode.commands.registerCommand("revizorro.decline", () => void host?.decline()),
    vscode.commands.registerCommand("revizorro.toggleViewMode", () => form?.toggleViewMode()),
    { dispose: () => void host?.stop() },
    { dispose: () => form?.dispose() },
  );
}

export function deactivate(): void {
  void host?.stop();
  form?.dispose();
}
