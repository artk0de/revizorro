/**
 * Headless review-host harness — stands in for the VS Code extension so the
 * full CLI <-> host <-> protocol loop can be exercised without VS Code.
 *
 * Mirrors the wiring of packages/extension/src/host.ts (ReviewHost) but drives
 * "human" actions from stdin instead of the form UI.
 *
 * Usage (after `pnpm -r build`), from the repo root:
 *   node scripts/mock-host.mjs
 * Then in another terminal run the CLI loop (or `/revizorro` in Claude Code):
 *   node packages/cli/dist/revizorro.cjs review --worktree
 *
 * Commands (typed into this process):
 *   a              approve   -> CLI's `review` returns {decision, approved}
 *   d              decline   -> returns {decision, declined}
 *   q <text>       ask the agent a question on the first file
 *   c <text>       leave a human comment on the first file
 *   n              start a new round (recompute diff, collapse unchanged viewed)
 */
import { HttpReviewHost, FsSessionStore, GitDiffProvider } from "../packages/core-adapters/dist/index.js";
import { startRound, applyPush } from "../packages/core/dist/index.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const worktreeId = createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
const store = new FsSessionStore(repoRoot);
const diff = new GitDiffProvider(repoRoot, "main");
const host = new HttpReviewHost();
let idN = 0;

const printThreads = (s) =>
  s.threads.forEach((t) => {
    const last = t.messages[t.messages.length - 1];
    console.log(`  [${t.id}] ${t.file}:${t.range.startLine} — ${last.author}: ${last.body}`);
  });

async function newRound() {
  const prev = await store.load(worktreeId);
  const files = await diff.diff(worktreeId);
  const s = startRound(prev, worktreeId, files);
  await store.save(s);
  console.log(`\n=== round ${s.round} — ${files.length} changed file(s) ===`);
  Object.entries(s.files).forEach(([p, fv]) => console.log(`  ${fv.viewed ? "▸" : "▾"} ${p}`));
  printThreads(s);
  return s;
}

host.onPush(async (_wt, push) => {
  const cur = await store.load(worktreeId);
  if (!cur) return;
  const next = applyPush(cur, push, () => `a${++idN}`);
  await store.save(next);
  console.log("\n[agent pushed]");
  printThreads(next);
});

const port = await host.start();
mkdirSync(join(repoRoot, ".claude", "revizorro"), { recursive: true });
writeFileSync(join(repoRoot, ".claude", "revizorro", "port"), String(port));
console.log(`mock-host listening on 127.0.0.1:${port}  (worktreeId=${worktreeId})`);
await newRound();
console.log("\ncommands: a=approve  d=decline  q <text>=question  c <text>=comment  n=new round\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const [cmd, ...rest] = line.trim().split(" ");
  const body = rest.join(" ");
  const s = await store.load(worktreeId);
  const file = Object.keys(s?.files ?? {})[0] ?? "README.md";
  const range = { startLine: 0, endLine: 0 };
  if (cmd === "a") host.emit(worktreeId, { type: "decision", verdict: "approved", comments: [] });
  else if (cmd === "d") host.emit(worktreeId, { type: "decision", verdict: "declined", comments: [] });
  else if (cmd === "q") host.emit(worktreeId, { type: "question", threadId: `q${++idN}`, file, range, body });
  else if (cmd === "c") host.emit(worktreeId, { type: "comment", threadId: `c${++idN}`, file, range, body });
  else if (cmd === "n") await newRound();
  else console.log("? (a | d | q <text> | c <text> | n)");
});
