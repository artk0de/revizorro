import type { ReviewTransport } from "@revizorro/core";
import type { PushPayload } from "@revizorro/protocol";

export interface CliDeps {
  transport: ReviewTransport;
  worktreeId: string;
  repoRoot: string;
  readPush: (path: string) => PushPayload;
}

const USAGE = [
  "revizorro — pre-merge code review CLI",
  "",
  "Usage:",
  "  revizorro review --worktree      start or continue a review round (blocks for one event)",
  "  revizorro review --push <file>   deliver an agent reply/comment, then block for the next event",
].join("\n");

export async function runReview(
  argv: string[],
  deps: CliDeps,
): Promise<{ stdout: string; exitCode: number }> {
  if (argv[0] !== "review") {
    const wantsHelp = argv.length === 0 || argv[0] === "--help" || argv[0] === "-h";
    return { stdout: USAGE, exitCode: wantsHelp ? 0 : 2 };
  }
  const pushIdx = argv.indexOf("--push");
  const push = pushIdx >= 0 ? deps.readPush(argv[pushIdx + 1]) : undefined;
  const event = await deps.transport.review(deps.worktreeId, deps.repoRoot, push);
  return { stdout: JSON.stringify(event), exitCode: 0 };
}
