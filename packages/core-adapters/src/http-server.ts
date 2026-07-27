import { createServer, type Server } from "node:http";
import type { ReviewEvent } from "@revizorro/protocol";
import { PushPayload } from "@revizorro/protocol";
import type { ReviewOptions } from "@revizorro/core";

type Waiter = (e: ReviewEvent) => void;

export class HttpReviewHost {
  private server?: Server;
  private readonly waiters = new Map<string, Waiter[]>();
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

  /** Hand the event to one blocked agent. Returns false when nobody was waiting. */
  emit(worktreeId: string, event: ReviewEvent): boolean {
    const q = this.waiters.get(worktreeId);
    const next = q?.shift();
    if (!next) return false;
    next(event);
    return true;
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
        list.push((event) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(event));
        });
        this.waiters.set(worktreeId, list);
        // A push is a reply delivery; a plain review is a request to (re)open the
        // form — so a late push can never resurrect a closed form.
        if (push === undefined) {
          this.onReviewRequest?.(worktreeId, repoRoot, opts ?? {});
        } else {
          this.onPushReceived?.(worktreeId, repoRoot, PushPayload.parse(push), opts ?? {});
        }
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
