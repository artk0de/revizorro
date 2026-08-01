import type { LegResult, UpdateLeg } from "./types.js";

export interface UpdateDeps {
  /** npm's `latest` dist-tag for the CLI — the one number every leg is held against. */
  fetchLatest: () => Promise<string | null>;
  /** Ordered: the CLI leg must run before the skill leg, which reads its bytes. */
  legs: UpdateLeg[];
}

const NO_TARGET =
  "Couldn't reach the npm registry to learn the latest version. Try again later.";

function render(r: LegResult): string {
  switch (r.state) {
    case "current":
      return `${r.leg}: ${r.version} (already current)`;
    case "updated":
      return `${r.leg}: ${r.from} → ${r.to}`;
    case "skipped":
      return `${r.leg}: skipped — ${r.reason}`;
    case "failed":
      return `${r.leg}: failed — ${r.reason}`;
  }
}

/**
 * Reconciles every leg against one version rather than reinstalling blindly.
 *
 * Without a target there is nothing to reconcile against, and guessing would be
 * worse than stopping: a half-applied set leaves the CLI talking to an extension
 * that speaks a different protocol. So a registry that did not answer stops the
 * run before any leg is touched.
 */
export async function runUpdate(deps: UpdateDeps): Promise<{ stdout: string; exitCode: number }> {
  const target = await deps.fetchLatest();
  if (target === null) return { stdout: NO_TARGET, exitCode: 1 };

  // Each leg is independent, so one failure does not strand the rest — a broken
  // VS Code CLI should not stop the skill from reaching the version the CLI is on.
  const results: LegResult[] = [];
  for (const leg of deps.legs) results.push(await leg(target));

  // A leg that knows the conventional code for its own failure gets to keep it;
  // anything else collapses to a plain 1.
  const failure = results.find((r) => r.state === "failed");
  const exitCode = failure === undefined ? 0 : ((failure as { exitCode?: number }).exitCode ?? 1);
  return { stdout: results.map(render).join("\n"), exitCode };
}
