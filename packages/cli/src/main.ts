import type { ReviewTransport, DiffProvider } from "@revizorro/core";
import type { PushPayload } from "@revizorro/protocol";

export interface CliDeps {
  transport: ReviewTransport;
  worktreeId: string;
  repoRoot: string;
  readPush: (path: string) => PushPayload;
  /** Git-side diff source for the `--check` preflight; no VS Code host needed. */
  diff?: DiffProvider;
}

/** `review --check` exit code when the worktree has a diff (mirrors git diff --exit-code convention). */
const HAS_DIFF_EXIT = 10;

const USAGE = [
  "revizorro — pre-merge code review CLI",
  "",
  "Usage:",
  "  revizorro review --worktree      start or continue a review round (blocks for one event)",
  "  revizorro review --push <file>   deliver an agent reply/comment, then block for the next event",
  "  revizorro review --check         exit 10 if the worktree has a diff, 0 if empty (no form, no host)",
  "",
  "Options:",
  "  --staged-only                    review only committed + staged changes (skip unstaged and untracked)",
].join("\n");

export async function runReview(
  argv: string[],
  deps: CliDeps,
): Promise<{ stdout: string; exitCode: number }> {
  if (argv[0] !== "review") {
    const wantsHelp = argv.length === 0 || argv[0] === "--help" || argv[0] === "-h";
    return { stdout: USAGE, exitCode: wantsHelp ? 0 : 2 };
  }
  // Preflight: report via exit code whether there's anything to review, without
  // opening the form or even needing a live VS Code window.
  if (argv.includes("--check") && deps.diff) {
    const files = await deps.diff.diff(deps.worktreeId);
    return { stdout: "", exitCode: files.length > 0 ? HAS_DIFF_EXIT : 0 };
  }
  const pushIdx = argv.indexOf("--push");
  const push = pushIdx >= 0 ? deps.readPush(argv[pushIdx + 1]) : undefined;
  const event = await deps.transport.review(deps.worktreeId, deps.repoRoot, push, {
    stagedOnly: argv.includes("--staged-only"),
  });
  return { stdout: JSON.stringify(event), exitCode: 0 };
}
