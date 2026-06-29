import type { ReviewTransport } from "@revizorro/core";
import type { PushPayload } from "@revizorro/protocol";

export interface CliDeps {
  transport: ReviewTransport;
  worktreeId: string;
  readPush: (path: string) => PushPayload;
}

export async function runReview(
  argv: string[],
  deps: CliDeps,
): Promise<{ stdout: string; exitCode: number }> {
  if (argv[0] !== "review") return { stdout: "", exitCode: 2 };
  const pushIdx = argv.indexOf("--push");
  const push = pushIdx >= 0 ? deps.readPush(argv[pushIdx + 1]) : undefined;
  const event = await deps.transport.review(deps.worktreeId, push);
  return { stdout: JSON.stringify(event), exitCode: 0 };
}
