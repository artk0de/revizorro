import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { ReviewTransport } from "@revizorro/core";
import {
  HttpReviewClient,
  GitDiffProvider,
  orderedHosts,
  unregisterHost,
  hostMatchesProject,
} from "@revizorro/core-adapters";
import { PushPayload } from "@revizorro/protocol";

import { runReview } from "./main.js";
import { reviewThroughAnyWindow } from "./reconnect.js";
import { resolveWorktreeId } from "./resolve-worktree.js";
import { runUpdate } from "./update/run-update.js";
import { npmLeg } from "./update/npm-leg.js";
import { skillLeg } from "./update/skill-leg.js";
import { extensionLeg } from "./update/extension-leg.js";
import { fetchLatest } from "./update/registry.js";
import { nodeShell } from "./update/node-shell.js";

/** What the bin prints and exits with; the bin owns the process, this owns the decision. */
export interface CliOutcome {
  stdout: string;
  exitCode: number;
}

const readPush = (p: string): PushPayload => PushPayload.parse(JSON.parse(readFileSync(p, "utf8")));

/**
 * Stands in for a window on the paths that never reach one — help and the `--check`
 * preflight both answer before `runReview` touches its transport.
 */
const noWindow: ReviewTransport = {
  review: async () => Promise.reject(new Error("no revizorro window on this path")),
};

/**
 * One CLI invocation, from argv to what the process should print and exit with.
 *
 * `packageRoot` is the installed package directory — only the bin can know it,
 * because only the bundle knows where it sits on disk.
 */
export async function runCli(argv: string[], packageRoot: string): Promise<CliOutcome> {
  // `update` needs neither a git repo nor a VS Code window — route it before both.
  if (argv[0] === "update") return runUpdateCommand(packageRoot);

  // Non-review commands (help) need no VS Code window.
  if (argv[0] !== "review") {
    return runReview(argv, { transport: noWindow, worktreeId: "", repoRoot: "", readPush });
  }

  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const worktreeId = resolveWorktreeId(process.cwd());

  // `--check` is a pure git preflight: no VS Code window required, exit-code only.
  if (argv.includes("--check")) return runCheck(argv, repoRoot, worktreeId);

  return runThroughWindow(argv, repoRoot, worktreeId);
}

async function runUpdateCommand(packageRoot: string): Promise<CliOutcome> {
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  // An npm-installed package always sits under node_modules. Anywhere else means
  // this is a linked working tree, which the CLI leg must not install over.
  const linked = !packageRoot.includes(`${sep}node_modules${sep}`);

  return runUpdate({
    fetchLatest,
    // Order is load-bearing: the CLI leg replaces the package on disk, and the
    // skill leg then publishes the payload from that fresh copy.
    legs: [
      npmLeg({ currentVersion: version, shell: nodeShell, linked }),
      skillLeg({
        pluginsRoot: join(homedir(), ".claude", "plugins"),
        payloadDir: join(packageRoot, "plugin"),
        now: () => new Date().toISOString(),
      }),
      extensionLeg({ shell: nodeShell, vsixPath: join(packageRoot, "extension.vsix") }),
    ],
  });
}

async function runCheck(argv: string[], repoRoot: string, worktreeId: string): Promise<CliOutcome> {
  const baseIdx = argv.indexOf("--base");
  // The preflight reports by exit code alone; it prints nothing.
  const { exitCode } = await runReview(argv, {
    transport: noWindow,
    diff: new GitDiffProvider(repoRoot, baseIdx >= 0 ? argv[baseIdx + 1] : undefined, {
      stagedOnly: argv.includes("--staged-only"),
    }),
    worktreeId,
    repoRoot,
    readPush,
  });
  return { stdout: "", exitCode };
}

async function runThroughWindow(
  argv: string[],
  repoRoot: string,
  worktreeId: string,
): Promise<CliOutcome> {
  // Prefer the window that owns THIS project (or the worktree's parent project);
  // fall back to any window with the extension.
  if (orderedHosts(repoRoot).length === 0) {
    throw new Error(
      "no revizorro window found — open a folder in VS Code with the revizorro extension",
    );
  }

  const warnForeignWindow = foreignWindowWarner(repoRoot);
  const started = Date.now();

  return reviewThroughAnyWindow({
    // Read afresh every sweep. A window that is restarting comes back on a NEW
    // port, so a list captured before the search began can never hold it.
    hosts: () => orderedHosts(repoRoot).map((h) => h.port),
    drop: (port) => {
      unregisterHost(port);
    },
    wait: async (ms) =>
      new Promise((r) => {
        setTimeout(r, ms);
      }),
    elapsed: () => Date.now() - started,
    attempt: async (port, carryPush) => {
      warnForeignWindow(port);
      return runReview(carryPush ? argv : withoutPush(argv), {
        transport: new HttpReviewClient(port),
        worktreeId,
        repoRoot,
        readPush,
      });
    },
  });
}

/**
 * Falling back to an unrelated window is legitimate (the agent may run from a
 * terminal with no window of its own), but the form then opens somewhere the human
 * is not looking — say so instead of leaving them staring at a dead tab.
 *
 * Said once per window, not once per attempt: a reload can make us try the same
 * window several times, and repeating the warning reads like a fault.
 */
function foreignWindowWarner(repoRoot: string): (port: number) => void {
  const warned = new Set<number>();
  return (port) => {
    const entry = orderedHosts(repoRoot).find((h) => h.port === port);
    if (!entry || hostMatchesProject(entry, repoRoot) || warned.has(port)) return;
    warned.add(port);
    process.stderr.write(
      `revizorro: no VS Code window has ${repoRoot} open — the review form will appear in ` +
        `the window for ${entry.project || "(no project)"}\n`,
    );
  };
}

/**
 * The same call with its `--push` dropped.
 *
 * Used when a retry follows a connection that died after it was established: the
 * push may already have been applied and written to the session, and sending it
 * again would put the agent's replies into the human's threads twice. The restored
 * window reads what was persisted instead.
 */
function withoutPush(argv: string[]): string[] {
  const at = argv.indexOf("--push");
  return at < 0 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
}
