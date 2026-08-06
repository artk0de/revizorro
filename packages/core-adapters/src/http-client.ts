import { request } from "node:http";
import { ReviewEvent, type PushPayload } from "@revizorro/protocol";
import type { ReviewOptions, ReviewTransport } from "@revizorro/core";

/**
 * Socket-level failures that mean "this review window is gone" — it closed, was
 * reloaded, or the extension was updated while the agent was blocked in a long
 * poll. Callers drop the stale registry entry and try the next window; anything
 * else (a host that answered something unparseable) is a real error worth raising.
 */
const DEAD_HOST_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
]);

export function isDeadHostError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && DEAD_HOST_CODES.has(code);
}

/**
 * Codes that mean the connection was up before it broke — so the window may well
 * have read the request, and any push it carried may already be persisted.
 *
 * `ECONNREFUSED` and friends are the opposite: nothing was ever delivered. The
 * distinction decides whether a retry may repeat a push, because replaying one
 * that landed duplicates the agent's replies in the human's threads.
 */
const DELIVERED_CODES = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT"]);

export function mayHaveBeenDelivered(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && DELIVERED_CODES.has(code);
}

export class HttpReviewClient implements ReviewTransport {
  constructor(
    private readonly port: number,
    private readonly host = "127.0.0.1",
  ) {}

  async review(
    worktreeId: string,
    repoRoot: string,
    push?: PushPayload,
    opts?: ReviewOptions,
  ): Promise<ReviewEvent> {
    const payload = JSON.stringify({ worktreeId, repoRoot, push, opts });
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: this.host,
          port: this.port,
          path: "/review",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            if (!body.trim()) {
              // Accepted the request, then went away without answering — same
              // meaning as a hang-up, so callers treat the window as gone.
              const gone: NodeJS.ErrnoException = new Error(
                "review host closed the connection without sending an event",
              );
              gone.code = "ECONNRESET";
              reject(gone);
              return;
            }
            try {
              const parsed: unknown = JSON.parse(body);
              resolve(ReviewEvent.parse(parsed));
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        },
      );
      req.on("error", (err) => {
        reject(err);
      });
      req.end(payload);
    });
  }
}
