import { describe, it, expect } from "vitest";
import { applyPush, editMessage } from "../src/index.js";
import type { SessionState } from "@revizorro/protocol";

const base: SessionState = {
  worktreeId: "wt1",
  round: 1,
  status: "open",
  files: {},
  threads: [
    {
      id: "t1",
      file: "a.ts",
      side: "new",
      range: { startLine: 1, endLine: 1 },
      messages: [{ author: "human", body: "why?" }],
      resolved: false,
    },
  ],
};

describe("applyPush", () => {
  it("appends an agent reply to an existing thread", () => {
    let n = 0;
    const idGen = () => `g${++n}`;
    const next = applyPush(
      base,
      { replies: [{ threadId: "t1", body: "because X" }], comments: [] },
      idGen,
    );
    expect(next.threads[0].messages).toHaveLength(2);
    expect(next.threads[0].messages[1]).toEqual({ author: "agent", body: "because X" });
    expect(base.threads[0].messages).toHaveLength(1); // input untouched
  });
  it("adds a new agent thread for a comment", () => {
    const next = applyPush(
      base,
      {
        replies: [],
        comments: [{ file: "b.ts", range: { startLine: 2, endLine: 4 }, body: "extract this" }],
      },
      () => "gen1",
    );
    expect(next.threads).toHaveLength(2);
    expect(next.threads[1]).toMatchObject({ id: "gen1", file: "b.ts" });
    expect(next.threads[1].messages[0]).toEqual({ author: "agent", body: "extract this" });
  });
  it("carries the side from an agent comment onto the new thread", () => {
    const next = applyPush(
      base,
      {
        replies: [],
        comments: [
          { file: "b.ts", side: "old", range: { startLine: 3, endLine: 3 }, body: "deleted code note" },
        ],
      },
      () => "gen1",
    );
    expect(next.threads[1]).toMatchObject({ id: "gen1", side: "old" });
  });
  it("edits a human message body in place without mutating the input", () => {
    const next = editMessage(base, "t1", 0, "rephrased?");
    expect(next.threads[0].messages[0].body).toBe("rephrased?");
    expect(base.threads[0].messages[0].body).toBe("why?");
  });
  it("refuses to edit an agent message", () => {
    const withAgent: SessionState = {
      ...base,
      threads: [
        {
          ...base.threads[0],
          messages: [...base.threads[0].messages, { author: "agent", body: "because X" }],
        },
      ],
    };
    const next = editMessage(withAgent, "t1", 1, "tampered");
    expect(next.threads[0].messages[1].body).toBe("because X");
  });
  it("ignores a reply to an unknown thread", () => {
    const next = applyPush(
      base,
      { replies: [{ threadId: "nope", body: "x" }], comments: [] },
      () => "g",
    );
    expect(next.threads[0].messages).toHaveLength(1);
  });
});
