import { describe, it, expect } from "vitest";
import { decideCollapsed } from "../src/index.js";

describe("decideCollapsed", () => {
  it("collapses a previously-viewed unchanged file", () => {
    const prev = { "a.ts": { viewed: true, contentHash: "h1" } };
    const r = decideCollapsed(prev, [{ path: "a.ts", contentHash: "h1" }]);
    expect(r.collapsed).toEqual(["a.ts"]);
    expect(r.files["a.ts"]).toEqual({ viewed: true, contentHash: "h1" });
  });
  it("expands a viewed file whose content changed", () => {
    const prev = { "a.ts": { viewed: true, contentHash: "h1" } };
    const r = decideCollapsed(prev, [{ path: "a.ts", contentHash: "h2" }]);
    expect(r.collapsed).toEqual([]);
    expect(r.files["a.ts"]).toEqual({ viewed: false, contentHash: "h2" });
  });
  it("treats a new file as expanded and unviewed", () => {
    const r = decideCollapsed({}, [{ path: "new.ts", contentHash: "h9" }]);
    expect(r.collapsed).toEqual([]);
    expect(r.files["new.ts"]).toEqual({ viewed: false, contentHash: "h9" });
  });
  it("drops files no longer in the diff", () => {
    const prev = { "gone.ts": { viewed: true, contentHash: "h1" } };
    const r = decideCollapsed(prev, [{ path: "a.ts", contentHash: "h1" }]);
    expect(r.files["gone.ts"]).toBeUndefined();
  });
});
