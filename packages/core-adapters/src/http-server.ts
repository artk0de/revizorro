import { createServer, type Server } from "node:http";
import { ReviewEvent, PushPayload } from "@revizorro/protocol";

type Waiter = (e: ReviewEvent) => void;

export class HttpReviewHost {
  private server?: Server;
  private waiters = new Map<string, Waiter[]>();
  private pushCb?: (worktreeId: string, push: PushPayload) => void;

  onPush(cb: (worktreeId: string, push: PushPayload) => void): void {
    this.pushCb = cb;
  }

  emit(worktreeId: string, event: ReviewEvent): void {
    const q = this.waiters.get(worktreeId);
    const next = q?.shift();
    if (next) next(event);
  }

  start(): Promise<number> {
    this.server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/review") {
        res.statusCode = 404;
        return res.end();
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { worktreeId, push } = JSON.parse(body || "{}");
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
    return new Promise((resolve) =>
      this.server!.listen(0, "127.0.0.1", () => {
        resolve((this.server!.address() as { port: number }).port);
      }),
    );
  }

  stop(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
