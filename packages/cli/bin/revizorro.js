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
  isDeadHostError,
  hostMatchesProject,
} from "@revizorro/core-adapters";
import { PushPayload } from "@revizorro/protocol";
import {
  runReview,
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
      extensionLeg({ shell: nodeShell }),
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

  for (const host of hosts) {
    const port = host.port;
    // Falling back to an unrelated window is legitimate (the agent may run from a
    // terminal with no window of its own), but the form then opens somewhere the
    // human is not looking — say so instead of leaving them staring at a dead tab.
    if (!hostMatchesProject(host, repoRoot)) {
      process.stderr.write(
        `revizorro: no VS Code window has ${repoRoot} open — the review form will appear in ` +
          `the window for ${host.project || "(no project)"}\n`,
      );
    }
    try {
      const { stdout, exitCode } = await runReview(argv, {
        transport: new HttpReviewClient(port),
        worktreeId,
        repoRoot,
        readPush,
      });
      if (stdout) process.stdout.write(`${stdout}\n`);
      process.exit(exitCode);
    } catch (err) {
      // The window is gone — closed, reloaded, or its extension was updated while
      // we were blocked on the long poll (that arrives as ECONNRESET, not
      // ECONNREFUSED). Drop the stale registry entry and try the next window.
      if (isDeadHostError(err)) {
        unregisterHost(port);
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `no live revizorro window (tried ${hosts.length}) — a window was reloaded or its ` +
      `extension updated mid-review. Reload a VS Code window with the extension, then re-run review`,
  );
}

main().catch((err) => {
  process.stderr.write(`revizorro: ${err.message ?? err}\n`);
  process.exit(1);
});
