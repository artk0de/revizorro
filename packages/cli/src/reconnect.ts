import { isDeadHostError, mayHaveBeenDelivered } from "@revizorro/core-adapters";

export interface WindowSearch<T> {
  /**
   * Ports worth trying, read afresh on every sweep. Re-reading is the point: a
   * window that is restarting registers a NEW port, which a list captured before
   * the search began can never contain.
   */
  hosts: () => number[];
  /** One attempt against one window. */
  attempt: (port: number, carryPush: boolean) => Promise<T>;
  /** Forget a window that did not answer. */
  drop: (port: number) => void;
  wait: (ms: number) => Promise<void>;
  /** Milliseconds since the search began. */
  elapsed: () => number;
}

export interface WindowSearchLimits {
  /** How long to keep looking for a window before giving up. */
  graceMs?: number;
  /** Gap between sweeps while nothing is answering. */
  pollMs?: number;
}

/** Long enough to outlast a VS Code window reload, short enough not to look hung. */
const GRACE_MS = 30_000;
const POLL_MS = 250;

/**
 * Runs a review against whichever window will take it, waiting out a reload.
 *
 * Reloading a window kills its extension host and brings a new one up on a new
 * port. A single pass over a list captured up front therefore always ends in "no
 * live revizorro window", even though a perfectly good window is seconds away —
 * which is why this keeps sweeping a freshly-read registry until one answers.
 *
 * The push needs more care than the connection does. A request that reached a
 * window may have been applied and persisted before the socket broke, so replaying
 * it would duplicate the agent's replies inside the human's threads. Once a
 * connection has died mid-flight the retry therefore re-arms the loop WITHOUT the
 * push: the restored window reads what was already saved. A request that never
 * arrived (connection refused) carries its push on, since nothing can have been
 * recorded from it.
 */
export async function reviewThroughAnyWindow<T>(
  search: WindowSearch<T>,
  limits: WindowSearchLimits = {},
): Promise<T> {
  const graceMs = limits.graceMs ?? GRACE_MS;
  const pollMs = limits.pollMs ?? POLL_MS;
  let carryPush = true;
  let tried = 0;

  for (;;) {
    for (const port of search.hosts()) {
      tried += 1;
      try {
        return await search.attempt(port, carryPush);
      } catch (err) {
        // Anything that is not a vanished window is the caller's problem, not
        // grounds for trying the same failure somewhere else.
        if (!isDeadHostError(err)) throw err;
        search.drop(port);
        if (mayHaveBeenDelivered(err)) carryPush = false;
      }
    }
    if (search.elapsed() >= graceMs) break;
    await search.wait(pollMs);
  }

  throw new Error(
    `no live revizorro window (tried ${tried} over ${Math.round(graceMs / 1000)}s) — open a ` +
      `VS Code window with the revizorro extension, then re-run review`,
  );
}
