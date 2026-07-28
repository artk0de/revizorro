import { describe, it, expect } from "vitest";
import { fileReviewState } from "../src/index.js";

const t = (resolved: boolean) => ({ resolved });

describe("fileReviewState", () => {
  it("treats a viewed file with no threads as done", () => {
    expect(fileReviewState([], true)).toEqual({
      openThreads: 0,
      allResolved: false,
      needsAttention: false,
    });
  });

  it("flags an unviewed file with no threads as still needing a look", () => {
    expect(fileReviewState([], false).needsAttention).toBe(true);
  });

  it("reports a file whose every thread is resolved", () => {
    const s = fileReviewState([t(true), t(true)], true);
    expect(s).toEqual({ openThreads: 0, allResolved: true, needsAttention: false });
  });

  it("counts only the unresolved threads", () => {
    expect(fileReviewState([t(true), t(false), t(false)], true).openThreads).toBe(2);
  });

  // The corner case: the agent comments on a file the human already ticked off.
  // The new thread is unresolved, so the file must climb back onto the radar even
  // though its viewed flag has not been recomputed yet.
  it("pulls a viewed file back to attention when an unresolved thread appears", () => {
    const s = fileReviewState([t(true), t(false)], true);
    expect(s.allResolved).toBe(false);
    expect(s.needsAttention).toBe(true);
  });

  it("keeps an un-viewed file with all threads resolved on the radar", () => {
    const s = fileReviewState([t(true)], false);
    expect(s.allResolved).toBe(true);
    expect(s.needsAttention).toBe(true);
  });
});
