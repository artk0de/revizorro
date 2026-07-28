import { describe, it, expect } from "vitest";
import { applyPush, editMessage, threadsInDiff } from "../src/index.js";
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

  // A session accumulates threads across rounds and scope switches: closed MRs,
  // deleted files, even another branch reviewed in the same window. A verdict must
  // carry only what the human was actually looking at.
  it("hands the agent only unresolved threads on files in the current diff", () => {
    const state: SessionState = {
      ...base,
      threads: [
        { ...base.threads[0], id: "t1", file: "current.ts" },
        { ...base.threads[0], id: "t2", file: "gone.ts" },
        { ...base.threads[0], id: "t3", file: "current.ts", resolved: true },
        { ...base.threads[0], id: "t4", file: "other-branch.ts" },
      ],
    };
    expect(threadsInDiff(state, ["current.ts", "untouched.ts"]).map((t) => t.id)).toEqual(["t1"]);
  });

  it("returns nothing when the diff is empty rather than everything", () => {
    expect(threadsInDiff(base, [])).toEqual([]);
  });

  const viewed: SessionState = {
    ...base,
    files: {
      "a.ts": { viewed: true, contentHash: "h1" },
      "b.ts": { viewed: true, contentHash: "h2" },
      "c.ts": { viewed: true, contentHash: "h3" },
    },
  };

  it("un-views a file when the agent replies in one of its threads", () => {
    const next = applyPush(
      viewed,
      { replies: [{ threadId: "t1", body: "because X" }], comments: [] },
      () => "g",
    );
    expect(next.files["a.ts"].viewed).toBe(false);
    expect(next.files["a.ts"].contentHash).toBe("h1");
    expect(next.files["c.ts"].viewed).toBe(true);
  });

  it("un-views a file when the agent opens a new comment on it", () => {
    const next = applyPush(
      viewed,
      { replies: [], comments: [{ file: "b.ts", range: { startLine: 2, endLine: 4 }, body: "fix" }] },
      () => "g",
    );
    expect(next.files["b.ts"].viewed).toBe(false);
    expect(next.files["a.ts"].viewed).toBe(true);
    expect(viewed.files["b.ts"].viewed).toBe(true); // input untouched
  });

  it("leaves file view state alone when the push touches nothing known", () => {
    const next = applyPush(
      viewed,
      { replies: [{ threadId: "nope", body: "x" }], comments: [] },
      () => "g",
    );
    expect(next.files).toEqual(viewed.files);
  });
});

describe("batch push", () => {
  const multi: SessionState = {
    ...base,
    files: { "a.ts": { viewed: true, contentHash: "h1" }, "b.ts": { viewed: true, contentHash: "h2" } },
    threads: [
      { ...base.threads[0], id: "t1", file: "a.ts" },
      { ...base.threads[0], id: "t2", file: "a.ts" },
      { ...base.threads[0], id: "t3", file: "b.ts" },
    ],
  };

  // Answering five threads with five pushes costs five blocking waits and leaves
  // the human watching the rest sit unanswered. One push must settle them all.
  it("applies replies to several threads in one push", () => {
    const next = applyPush(
      multi,
      {
        replies: [
          { threadId: "t1", body: "first answer" },
          { threadId: "t3", body: "third answer" },
        ],
        comments: [],
      },
      () => "g",
    );
    expect(next.threads[0].messages.at(-1)).toEqual({ author: "agent", body: "first answer" });
    expect(next.threads[1].messages).toHaveLength(1); // untouched
    expect(next.threads[2].messages.at(-1)).toEqual({ author: "agent", body: "third answer" });
  });

  it("un-views every file the batch touched", () => {
    const next = applyPush(
      multi,
      { replies: [{ threadId: "t1", body: "x" }, { threadId: "t3", body: "y" }], comments: [] },
      () => "g",
    );
    expect(next.files["a.ts"].viewed).toBe(false);
    expect(next.files["b.ts"].viewed).toBe(false);
  });

  it("mixes replies and brand-new comments in the same push", () => {
    let n = 0;
    const next = applyPush(
      multi,
      {
        replies: [{ threadId: "t2", body: "answered" }],
        comments: [
          { file: "b.ts", range: { startLine: 9, endLine: 9 }, body: "one more thing" },
          { file: "a.ts", range: { startLine: 4, endLine: 4 }, body: "and this" },
        ],
      },
      () => `g${++n}`,
    );
    expect(next.threads).toHaveLength(5);
    expect(next.threads.slice(3).map((t) => t.id)).toEqual(["g1", "g2"]);
  });

  it("ignores unknown thread ids without dropping the rest of the batch", () => {
    const next = applyPush(
      multi,
      { replies: [{ threadId: "nope", body: "lost" }, { threadId: "t1", body: "kept" }], comments: [] },
      () => "g",
    );
    expect(next.threads[0].messages.at(-1)).toEqual({ author: "agent", body: "kept" });
  });
});
