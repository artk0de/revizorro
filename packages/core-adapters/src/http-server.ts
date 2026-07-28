import { createServer, type Server } from "node:http";
import type { ReviewEvent } from "@revizorro/protocol";
import { PushPayload } from "@revizorro/protocol";
import type { ReviewOptions } from "@revizorro/core";

type Waiter = (e: ReviewEvent) => void;

export class HttpReviewHost {
  private server?: Server;
  private readonly waiters = new Map<string, Waiter[]>();
  /** Events raised while no agent was polling, waiting for its next call. */
  private readonly held = new Map<string, ReviewEvent[]>();
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
    const next = this.waiters.get(worktreeId)?.shift();
    if (next) {
      next(event);
      return true;
    }
    if (holdIfIdle) {
      const q = this.held.get(worktreeId) ?? [];
      q.push(event);
      this.held.set(worktreeId, q);
    }
    return false;
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
    waiter(event);
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
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(event));
        };
        list.push(waiter);
        this.waiters.set(worktreeId, list);
        // A cancelled command or a closed terminal leaves its request behind. Left in
        // the queue it stays first in line and swallows the next event — the human
        // approves, and the agent that is actually listening never hears about it.
        res.on("close", () => {
          const queue = this.waiters.get(worktreeId);
          const at = queue?.indexOf(waiter) ?? -1;
          if (queue && at >= 0) queue.splice(at, 1);
        });
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
