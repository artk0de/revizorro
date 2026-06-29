import { request } from "node:http";
import { ReviewEvent, type PushPayload } from "@revizorro/protocol";
import type { ReviewTransport } from "@revizorro/core";

export class HttpReviewClient implements ReviewTransport {
  constructor(
    private readonly port: number,
    private readonly host = "127.0.0.1",
  ) {}

  review(worktreeId: string, push?: PushPayload): Promise<ReviewEvent> {
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
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(ReviewEvent.parse(JSON.parse(body)));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }
}
