#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  HttpReviewClient,
  GitDiffProvider,
  orderedHosts,
  unregisterHost,
} from "@revizorro/core-adapters";
import { PushPayload } from "@revizorro/protocol";
import { runReview, resolveWorktreeId } from "@revizorro/cli";

const readPush = (p) => PushPayload.parse(JSON.parse(readFileSync(p, "utf8")));

async function main() {
  const argv = process.argv.slice(2);

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
    const { exitCode } = await runReview(argv, {
      transport: null,
      diff: new GitDiffProvider(repoRoot, undefined, {
        stagedOnly: argv.includes("--staged-only"),
      }),
      worktreeId,
      repoRoot,
      readPush,
    });
    process.exit(exitCode);
  }

  // Prefer a window that has THIS project open; else any window with the extension.
  const ports = orderedHosts(repoRoot).map((h) => h.port);
  if (ports.length === 0) {
    throw new Error(
      "no revizorro window found — open a folder in VS Code with the revizorro extension",
    );
  }

  for (const port of ports) {
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
      // Dead host (window closed) → drop the stale registry entry and try the next.
      if (err && err.code === "ECONNREFUSED") {
        unregisterHost(port);
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `no live revizorro window (tried ${ports.length}) — reload a VS Code window with the extension`,
  );
}

main().catch((err) => {
  process.stderr.write(`revizorro: ${err.message ?? err}\n`);
  process.exit(1);
});
