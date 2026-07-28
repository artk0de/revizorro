import { createServer, type Server } from "node:http";
import type { ReviewEvent } from "@revizorro/protocol";
import { PushPayload } from "@revizorro/protocol";
import type { ReviewOptions } from "@revizorro/core";

type Waiter = (e: ReviewEvent) => void;

/**
 * How long one call may block before it is answered with `idle`. A review can take
 * the human all afternoon, but a single CLI call that never returns reads as a hung
 * command — so each poll is bounded and the agent re-arms.
 */
const DEFAULT_POLL_TIMEOUT_MS = 60_000;

export interface HttpReviewHostOptions {
  pollTimeoutMs?: number;
}

export class HttpReviewHost {
  private readonly pollTimeoutMs: number;

  constructor(options: HttpReviewHostOptions = {}) {
    const fromEnv = Number(process.env.REVIZORRO_POLL_TIMEOUT_MS);
    this.pollTimeoutMs =
      options.pollTimeoutMs ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_POLL_TIMEOUT_MS);
  }

  private server?: Server;
  private readonly waiters = new Map<string, Waiter[]>();
  /** Events raised while no agent was polling, waiting for its next call. */
  private readonly held = new Map<string, ReviewEvent[]>();
  private waitingChanged?: (worktreeId: string, waiting: boolean) => void;
  private idleEvent?: (worktreeId: string) => ReviewEvent;
  private onPushReceived?: (
    worktreeId: string,
    repoRoot: string,
    push: PushPayload,
    opts: ReviewOptions,
  ) => void;
  private onReviewRequest?: (worktreeId: string, repoRoot: string, opts: ReviewOptions) => void;

  onPush(
    cb: (worktreeId: string, repoRoot: string, push: PushPayload, opts: ReviewOptions) => void,
  ): void {
    this.onPushReceived = cb;
  }

  /** Fires on every `review` request — lets the host review the requested repoRoot. */
  onReview(cb: (worktreeId: string, repoRoot: string, opts: ReviewOptions) => void): void {
    this.onReviewRequest = cb;
  }

  /**
   * Hand the event to one blocked agent. Returns false when nobody was waiting.
   *
   * With `holdIfIdle`, an undelivered event is kept and handed to the next caller
   * instead of being dropped — the human can ask a second question while the agent
   * is off writing the answer to the first, and it is not polling in that gap.
   */
  emit(worktreeId: string, event: ReviewEvent, holdIfIdle = false): boolean {
    // Stamped when the human acted, not when it is delivered: a held event stays
    // honest about its age, so the agent can tell fresh-but-late from stale.
    const stamped: ReviewEvent = { ...event, at: event.at ?? Date.now() };
    const next = this.waiters.get(worktreeId)?.shift();
    if (next) {
      next(stamped);
      return true;
    }
    if (holdIfIdle) {
      const q = this.held.get(worktreeId) ?? [];
      q.push(stamped);
      this.held.set(worktreeId, q);
    }
    return false;
  }

  /** Whether an agent is blocked on this worktree right now. */
  isWaiting(worktreeId: string): boolean {
    return (this.waiters.get(worktreeId)?.length ?? 0) > 0;
  }

  /** Fires whenever an agent starts or stops waiting, so the form can say which. */
  onWaitingChanged(cb: (worktreeId: string, waiting: boolean) => void): void {
    this.waitingChanged = cb;
  }

  /** Supplies the event a timed-out poll answers with, so idle can carry context. */
  onIdle(cb: (worktreeId: string) => ReviewEvent): void {
    this.idleEvent = cb;
  }

  /** Give a freshly arrived caller the oldest event raised while it was away. */
  private deliverHeld(worktreeId: string): void {
    const q = this.held.get(worktreeId);
    const event = q?.[0];
    if (!q || event === undefined) return;
    const waiter = this.waiters.get(worktreeId)?.shift();
    if (!waiter) return;
    q.shift();
    if (q.length === 0) this.held.delete(worktreeId);
    // Flagged so an instant answer does not read as a stale replay: it was raised
    // while the agent was away and is being handed over now.
    waiter({ ...event, held: true });
  }

  async start(): Promise<number> {
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/review") {
        res.statusCode = 404;
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const { worktreeId, repoRoot, push, opts } = JSON.parse(body || "{}") as {
          worktreeId: string;
          repoRoot: string;
          push?: unknown;
          opts?: ReviewOptions;
        };
        // Register the response waiter BEFORE invoking onPushReceived: a push handler may
        // synchronously emit an event, which must find a waiting client.
        const list = this.waiters.get(worktreeId) ?? [];
        const waiter: Waiter = (event) => {
          clearTimeout(timer);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(event));
        };
        list.push(waiter);
        this.waiters.set(worktreeId, list);
        // Bound the poll: pull this waiter out of the queue and answer `idle` so the
        // agent's command returns and the loop re-arms.
        const timer = setTimeout(() => {
          const queue = this.waiters.get(worktreeId);
          const at = queue?.indexOf(waiter) ?? -1;
          if (!queue || at < 0) return;
          queue.splice(at, 1);
          waiter(this.idleEvent?.(worktreeId) ?? { type: "idle" });
        }, this.pollTimeoutMs);
        timer.unref?.();
        // A cancelled command or a closed terminal leaves its request behind. Left in
        // the queue it stays first in line and swallows the next event — the human
        // approves, and the agent that is actually listening never hears about it.
        res.on("close", () => {
          const queue = this.waiters.get(worktreeId);
          const at = queue?.indexOf(waiter) ?? -1;
          if (queue && at >= 0) queue.splice(at, 1);
          this.waitingChanged?.(worktreeId, this.isWaiting(worktreeId));
        });
        this.waitingChanged?.(worktreeId, true);
        // A push is a reply delivery; a plain review is a request to (re)open the
        // form — so a late push can never resurrect a closed form.
        if (push === undefined) {
          this.onReviewRequest?.(worktreeId, repoRoot, opts ?? {});
        } else {
          this.onPushReceived?.(worktreeId, repoRoot, PushPayload.parse(push), opts ?? {});
        }
        // Anything the human raised while this agent was away is answered now,
        // ahead of it settling into another long poll.
        this.deliverHeld(worktreeId);
      });
    });
    this.server = server;
    return new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      }),
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    // Every waiting agent holds an open long poll by design, and close() waits for
    // in-flight requests — so without this the shutdown never completes and each
    // blocked agent hangs until the process itself dies.
    server.closeAllConnections();
    return new Promise((r) =>
      server.close(() => {
        r();
      }),
    );
  }
}
