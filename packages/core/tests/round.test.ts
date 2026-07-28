import { describe, it, expect } from "vitest";
import {
  startRound,
  applyDecision,
  markVerdictDelivered,
  markVerdictPending,
  isVerdictReplayable,
  scopeChanged,
  resolveScope,
} from "../src/index.js";
import type { SessionState } from "@revizorro/protocol";

describe("startRound", () => {
  it("starts round 1 from null with unviewed files", () => {
    const s = startRound(null, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    expect(s.round).toBe(1);
    expect(s.status).toBe("open");
    expect(s.files["a.ts"]).toEqual({ viewed: false, contentHash: "h1" });
    expect(s.threads).toEqual([]);
  });
  it("increments round and collapses unchanged viewed files", () => {
    const prev: SessionState = {
      worktreeId: "wt1",
      round: 1,
      status: "changes_requested",
      files: { "a.ts": { viewed: true, contentHash: "h1" } },
      threads: [
        {
          id: "t1",
          file: "a.ts",
          range: { startLine: 1, endLine: 1 },
          messages: [{ author: "human", body: "x" }],
          resolved: true,
        },
        {
          id: "t2",
          file: "a.ts",
          range: { startLine: 2, endLine: 2 },
          messages: [{ author: "human", body: "y" }],
          resolved: false,
        },
      ],
    };
    const s = startRound(prev, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    expect(s.round).toBe(2);
    expect(s.files["a.ts"].viewed).toBe(true);
    expect(s.threads.map((t) => t.id)).toEqual(["t2"]); // resolved dropped
  });
});

describe("review scope", () => {
  const staged = { stagedOnly: true, baseRef: "" };
  const whole = { stagedOnly: false, baseRef: "" };

  it("records the scope the round was opened with", () => {
    expect(startRound(null, "wt1", [], staged).scope).toEqual(staged);
  });

  it("defaults to a whole-branch scope when none is given", () => {
    expect(startRound(null, "wt1", []).scope).toEqual({ stagedOnly: false, baseRef: "" });
  });

  it("sees a switch between staged-only and whole-branch as a different review", () => {
    const open = startRound(null, "wt1", [], whole);
    expect(scopeChanged(open, staged)).toBe(true);
    expect(scopeChanged(open, whole)).toBe(false);
  });

  it("sees a different target branch as a different review", () => {
    const open = startRound(null, "wt1", [], { stagedOnly: false, baseRef: "develop" });
    expect(scopeChanged(open, { stagedOnly: false, baseRef: "release/9" })).toBe(true);
    expect(scopeChanged(open, { stagedOnly: false, baseRef: "develop" })).toBe(false);
  });

  // The scope belongs to the round, not to each command. An agent that omits
  // --staged-only on a follow-up call (a --push, say) must not silently flip the
  // review to the whole branch behind the human's back.
  it("keeps the open round's scope when the caller asks for nothing specific", () => {
    const open = startRound(null, "wt1", [], { stagedOnly: true, baseRef: "develop" });
    expect(resolveScope(open, {})).toEqual({ stagedOnly: true, baseRef: "develop" });
  });

  it("lets an explicit request override the open round's scope", () => {
    const open = startRound(null, "wt1", [], staged);
    expect(resolveScope(open, { stagedOnly: false })).toEqual({
      stagedOnly: false,
      baseRef: "",
    });
    expect(resolveScope(open, { baseRef: "release/9" })).toEqual({
      stagedOnly: true,
      baseRef: "release/9",
    });
  });

  it("falls back to whole-branch when there is no round to inherit from", () => {
    expect(resolveScope(null, {})).toEqual(whole);
  });

  it("does not inherit the scope of a round that is already decided", () => {
    const decided = applyDecision(startRound(null, "wt1", [], staged), "approved");
    expect(resolveScope(decided, {})).toEqual(whole);
  });

  it("treats a session written before scopes existed as whole-branch", () => {
    const legacy = { ...startRound(null, "wt1", []), scope: undefined } as unknown as SessionState;
    expect(scopeChanged(legacy, whole)).toBe(false);
    expect(scopeChanged(legacy, staged)).toBe(true);
  });
});

describe("applyDecision", () => {
  it("sets status to approved", () => {
    const s = startRound(null, "wt1", []);
    expect(applyDecision(s, "approved").status).toBe("approved");
  });
  it("leaves a fresh verdict undelivered so a missed decision can be replayed", () => {
    const s = applyDecision(startRound(null, "wt1", []), "approved");
    expect(s.verdictDelivered).toBe(false);
  });
  it("marks the verdict delivered once an agent has received it", () => {
    const s = markVerdictDelivered(applyDecision(startRound(null, "wt1", []), "approved"));
    expect(s.verdictDelivered).toBe(true);
    expect(s.status).toBe("approved");
  });
  it("replays a verdict the agent just missed (it was starting up)", () => {
    const now = 1_000_000;
    const s = markVerdictPending(applyDecision(startRound(null, "wt1", []), "approved"), now);
    expect(isVerdictReplayable(s, now + 3_000)).toBe(true);
  });
  it("stops replaying a stale verdict — a later review wants a new round", () => {
    const now = 1_000_000;
    const s = markVerdictPending(applyDecision(startRound(null, "wt1", []), "approved"), now);
    expect(isVerdictReplayable(s, now + 60 * 60 * 1000)).toBe(false);
  });
  it("never replays a verdict the agent already received", () => {
    const now = 1_000_000;
    const s = markVerdictDelivered(applyDecision(startRound(null, "wt1", []), "approved"));
    expect(isVerdictReplayable(s, now)).toBe(false);
  });
  it("never replays while the round is still open", () => {
    expect(isVerdictReplayable(startRound(null, "wt1", []), 1_000_000)).toBe(false);
  });
  it("clears the delivery flag when the next round opens", () => {
    const decided = applyDecision(startRound(null, "wt1", []), "changes_requested");
    const next = startRound(decided, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    expect(next.status).toBe("open");
    expect(next.verdictDelivered).toBe(false);
  });
});
