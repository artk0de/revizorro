#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
  HttpReviewClient,
  GitDiffProvider,
  orderedHosts,
  unregisterHost,
  hostMatchesProject,
} from "@revizorro/core-adapters";
import { PushPayload } from "@revizorro/protocol";
import {
  runReview,
  reviewThroughAnyWindow,
  resolveWorktreeId,
  runUpdate,
  npmLeg,
  skillLeg,
  extensionLeg,
  fetchLatest,
  nodeShell,
} from "@revizorro/cli";

const readPush = (p) => PushPayload.parse(JSON.parse(readFileSync(p, "utf8")));

// esbuild emits CJS, where `import.meta.url` is undefined but `__dirname` is real.
// The bundle lives in dist/, so its package.json — and the plugin payload beside
// it — are one level up.
const packageRoot = join(__dirname, "..");

async function update() {
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  // An npm-installed package always sits under node_modules. Anywhere else means
  // this is a linked working tree, which the CLI leg must not install over.
  const linked = !packageRoot.includes(`${sep}node_modules${sep}`);

  const { stdout, exitCode } = await runUpdate({
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
  if (stdout) process.stdout.write(`${stdout}\n`);
  process.exit(exitCode);
}

async function main() {
  const argv = process.argv.slice(2);

  // `update` needs neither a git repo nor a VS Code window — route it before both.
  if (argv[0] === "update") return update();

  // Non-review commands (help) need no VS Code window.
  if (argv[0] !== "review") {
    const { stdout, exitCode } = await runReview(argv, {
      transport: null,
      worktreeId: "",
      repoRoot: "",
      readPush,
    });
    if (stdout) process.stdout.write(`${stdout}\n`);
    process.exit(exitCode);
  }

  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const worktreeId = resolveWorktreeId(process.cwd());

  // `--check` is a pure git preflight: no VS Code window required, exit-code only.
  if (argv.includes("--check")) {
    const baseIdx = argv.indexOf("--base");
    const { exitCode } = await runReview(argv, {
      transport: null,
      diff: new GitDiffProvider(repoRoot, baseIdx >= 0 ? argv[baseIdx + 1] : undefined, {
        stagedOnly: argv.includes("--staged-only"),
      }),
      worktreeId,
      repoRoot,
      readPush,
    });
    process.exit(exitCode);
  }

  // Prefer the window that owns THIS project (or the worktree's parent project);
  // fall back to any window with the extension.
  const hosts = orderedHosts(repoRoot);
  if (hosts.length === 0) {
    throw new Error(
      "no revizorro window found — open a folder in VS Code with the revizorro extension",
    );
  }

  // Say the mismatch once per window, not once per attempt: a reload can make us
  // try the same window several times, and repeating the warning reads like a fault.
  const warned = new Set();
  const started = Date.now();

  const { stdout, exitCode } = await reviewThroughAnyWindow({
    // Read afresh every sweep. A window that is restarting comes back on a NEW
    // port, so a list captured before the search began can never hold it.
    hosts: () => orderedHosts(repoRoot).map((h) => h.port),
    drop: (port) => unregisterHost(port),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    elapsed: () => Date.now() - started,
    attempt: async (port, carryPush) => {
      const entry = orderedHosts(repoRoot).find((h) => h.port === port);
      // Falling back to an unrelated window is legitimate (the agent may run from a
      // terminal with no window of its own), but the form then opens somewhere the
      // human is not looking — say so instead of leaving them staring at a dead tab.
      if (entry && !hostMatchesProject(entry, repoRoot) && !warned.has(port)) {
        warned.add(port);
        process.stderr.write(
          `revizorro: no VS Code window has ${repoRoot} open — the review form will appear in ` +
            `the window for ${entry.project || "(no project)"}\n`,
        );
      }
      return runReview(carryPush ? argv : withoutPush(argv), {
        transport: new HttpReviewClient(port),
        worktreeId,
        repoRoot,
        readPush,
      });
    },
  });

  if (stdout) process.stdout.write(`${stdout}\n`);
  process.exit(exitCode);
}

/**
 * The same call with its `--push` dropped.
 *
 * Used when a retry follows a connection that died after it was established: the
 * push may already have been applied and written to the session, and sending it
 * again would put the agent's replies into the human's threads twice. The restored
 * window reads what was persisted instead.
 */
function withoutPush(argv) {
  const at = argv.indexOf("--push");
  return at < 0 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
}

main().catch((err) => {
  process.stderr.write(`revizorro: ${err.message ?? err}\n`);
  process.exit(1);
});
