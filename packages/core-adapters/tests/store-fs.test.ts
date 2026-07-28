import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
  // The host saves from several places at once — an agent push landing while the
  // human posts a comment. Sharing one temp filename made those saves race and the
  // loser blow up with ENOENT on rename.
  it("survives concurrent saves of the same session", async () => {
    const store = new FsSessionStore(root);
    const base = startRound(null, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.save({ ...base, round: i + 1 })),
    );
    const loaded = await store.load("wt1");
    expect(loaded).not.toBeNull();
    expect(loaded?.worktreeId).toBe("wt1");
  });

  it("returns null for a session written by an incompatible schema instead of throwing", async () => {
    const store = new FsSessionStore(root);
    const p = join(root, ".claude", "revizorro", "wt1", "session.json");
    mkdirSync(dirname(p), { recursive: true });
    // `status: "declined"` is from an older enum — must not crash the form.
    writeFileSync(p, JSON.stringify({ worktreeId: "wt1", round: 1, status: "declined", files: {}, threads: [] }));
    expect(await store.load("wt1")).toBeNull();
  });
});
