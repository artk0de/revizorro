import { createServer, type Server } from "node:http";
import type { ReviewEvent } from "@revizorro/protocol";
import { PushPayload } from "@revizorro/protocol";

type Waiter = (e: ReviewEvent) => void;

export class HttpReviewHost {
  private server?: Server;
  private readonly waiters = new Map<string, Waiter[]>();
  private onPushReceived?: (worktreeId: string, push: PushPayload) => void;
  private onReviewRequest?: (worktreeId: string) => void;

  onPush(cb: (worktreeId: string, push: PushPayload) => void): void {
    this.onPushReceived = cb;
  }

  /** Fires on every `review` request — lets the host re-open/refresh a closed form. */
  onReview(cb: (worktreeId: string) => void): void {
    this.onReviewRequest = cb;
  }

  emit(worktreeId: string, event: ReviewEvent): void {
    const q = this.waiters.get(worktreeId);
    const next = q?.shift();
    if (next) next(event);
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
        const { worktreeId, push } = JSON.parse(body || "{}") as {
          worktreeId: string;
          push?: unknown;
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
          this.onReviewRequest?.(worktreeId);
        } else {
          this.onPushReceived?.(worktreeId, PushPayload.parse(push));
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
    return new Promise((r) =>
      this.server
        ? this.server.close(() => {
            r();
          })
        : r(),
    );
  }
}
