import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSessionStore } from "../src/index.js";
import { startRound } from "@revizorro/core";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rvz-"));
});

describe("FsSessionStore", () => {
  it("returns null before any save", async () => {
    expect(await new FsSessionStore(root).load("wt1")).toBeNull();
  });
  it("round-trips a saved session", async () => {
    const store = new FsSessionStore(root);
    const s = startRound(null, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    await store.save(s);
    expect(await store.load("wt1")).toEqual(s);
  });
});
