import { request } from "node:http";
import { ReviewEvent, type PushPayload } from "@revizorro/protocol";
import type { ReviewTransport } from "@revizorro/core";

export class HttpReviewClient implements ReviewTransport {
  constructor(
    private readonly port: number,
    private readonly host = "127.0.0.1",
  ) {}

  async review(worktreeId: string, push?: PushPayload): Promise<ReviewEvent> {
    const payload = JSON.stringify({ worktreeId, push });
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
