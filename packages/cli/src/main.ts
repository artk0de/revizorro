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
  "  revizorro update                 bring the CLI, the VS Code extension and the Claude skill to one version",
  "",
  "Options:",
  "  --staged-only                    review just the staged change, against HEAD (skip unstaged and untracked)",
  "  --base <ref>                     target branch to review against (default: origin/HEAD, else main/master)",
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
  const baseIdx = argv.indexOf("--base");
  // Only send what was actually asked for. A call with no scope flags inherits the
  // open round's scope, so forgetting --staged-only on a follow-up (a --push, or
  // re-arming the loop) cannot silently widen the review to the whole branch.
  const stagedOnly = argv.includes("--staged-only")
    ? true
    : argv.includes("--worktree")
      ? false
      : undefined;
  const event = await deps.transport.review(deps.worktreeId, deps.repoRoot, push, {
    ...(stagedOnly === undefined ? {} : { stagedOnly }),
    ...(baseIdx >= 0 && argv[baseIdx + 1] ? { baseRef: argv[baseIdx + 1] } : {}),
  });
  return { stdout: JSON.stringify(event), exitCode: 0 };
}
