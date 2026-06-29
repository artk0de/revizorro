#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HttpReviewClient } from "@revizorro/core-adapters";
import { PushPayload } from "@revizorro/protocol";
import { runReview, resolveWorktreeId } from "@revizorro/cli";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const port = Number(readFileSync(join(repoRoot, ".claude", "revizorro", "port"), "utf8").trim());

const deps = {
  transport: new HttpReviewClient(port),
  worktreeId: resolveWorktreeId(process.cwd()),
  readPush: (p) => PushPayload.parse(JSON.parse(readFileSync(p, "utf8"))),
};

const { stdout, exitCode } = await runReview(process.argv.slice(2), deps);
if (stdout) process.stdout.write(stdout + "\n");
process.exit(exitCode);
