import { createServer, type Server } from "node:http";
import type { ReviewEvent } from "@revizorro/protocol";
import { PushPayload } from "@revizorro/protocol";

type Waiter = (e: ReviewEvent) => void;

export class HttpReviewHost {
  private server?: Server;
  private readonly waiters = new Map<string, Waiter[]>();
  private pushCb?: (worktreeId: string, push: PushPayload) => void;

  onPush(cb: (worktreeId: string, push: PushPayload) => void): void {
    this.pushCb = cb;
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
        // Register the response waiter BEFORE invoking pushCb: a push handler may
        // synchronously emit an event, which must find a waiting client.
        const list = this.waiters.get(worktreeId) ?? [];
        list.push((event) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(event));
        });
        this.waiters.set(worktreeId, list);
        if (push !== undefined && this.pushCb) this.pushCb(worktreeId, PushPayload.parse(push));
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
