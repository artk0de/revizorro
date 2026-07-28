import { describe, it, expect } from "vitest";
import { parsePatch, diffStat, withExpansions, LOCKFILE } from "../media/view/patch.js";

const PATCH = [
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -3,3 +3,4 @@",
  " const untouched = 1;",
  "-const removed = 2;",
  "+const added = 2;",
  "+const alsoAdded = 3;",
  " const tail = 4;",
].join("\n");

describe("parsePatch", () => {
  it("drops git's preamble and keeps the hunk header", () => {
    const kinds = parsePatch(PATCH).map((l) => l.kind);
    expect(kinds).toEqual(["hunk", "ctx", "del", "add", "add", "ctx"]);
  });

  it("numbers both sides from the hunk header", () => {
    const lines = parsePatch(PATCH);
    expect(lines[1]).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 3 });
    expect(lines[2]).toMatchObject({ kind: "del", oldNo: 4 });
    expect(lines[2].newNo).toBeUndefined(); // a deleted line exists on the old side only
    expect(lines[3]).toMatchObject({ kind: "add", newNo: 4 });
    expect(lines[3].oldNo).toBeUndefined();
    expect(lines[4]).toMatchObject({ kind: "add", newNo: 5 });
    // Context after the change advances both sides past what was added/removed.
    expect(lines[5]).toMatchObject({ kind: "ctx", oldNo: 5, newNo: 6 });
  });

  it("strips only the leading marker, preserving indentation", () => {
    const lines = parsePatch(["@@ -1,1 +1,1 @@", "+    indented();"].join("\n"));
    expect(lines[1].text).toBe("    indented();");
  });

  it("does not mistake a removed line starting with --- for a preamble line", () => {
    const lines = parsePatch(["@@ -1,1 +1,1 @@", " ok"].join("\n"));
    expect(lines).toHaveLength(2);
  });

  it("returns nothing for an empty patch", () => {
    expect(parsePatch("")).toEqual([{ kind: "ctx", oldNo: 0, newNo: 0, text: "" }]);
  });
});

describe("diffStat", () => {
  it("counts changed lines, ignoring the file headers", () => {
    expect(diffStat(PATCH)).toEqual({ add: 2, del: 1 });
  });

  it("reports zeroes for a patch with no changes", () => {
    expect(diffStat("")).toEqual({ add: 0, del: 0 });
  });
});

describe("LOCKFILE", () => {
  it("matches lockfiles anywhere in the tree", () => {
    expect(LOCKFILE.test("package-lock.json")).toBe(true);
    expect(LOCKFILE.test("apps/web/yarn.lock")).toBe(true);
    expect(LOCKFILE.test("Cargo.lock")).toBe(true);
  });

  it("leaves ordinary sources alone", () => {
    expect(LOCKFILE.test("src/lock.ts")).toBe(false);
    expect(LOCKFILE.test("docs/package-lock.json.md")).toBe(false);
  });
});

describe("withExpansions", () => {
  const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  const file = { path: "a.ts", content };
  // A hunk covering lines 5-6 only: everything above and below is hidden context.
  const lines = parsePatch(["@@ -5,2 +5,2 @@", "-line 5 old", "+line 5", " line 6"].join("\n"));

  it("offers an expand control for the gap above and below the hunk", () => {
    const out = withExpansions(file, lines, new Map());
    const controls = out.filter((l) => l.kind === "expand");
    expect(controls).toHaveLength(2);
    expect(controls[0].gap?.key).toBe("a.ts#top");
    expect(controls[1].gap?.key).toBe("a.ts#bottom");
    expect(controls[0].gap?.up).toBe(4); // lines 1-4 are hidden
  });

  it("reveals the requested number of lines nearest the hunk", () => {
    const out = withExpansions(file, lines, new Map([["a.ts#top", 2]]));
    const revealed = out.filter((l) => l.kind === "ctx" && l.newNo !== undefined && l.newNo < 5);
    expect(revealed.map((l) => l.text)).toEqual(["line 3", "line 4"]);
  });

  it("drops the control once a gap is fully revealed", () => {
    const out = withExpansions(file, lines, new Map([["a.ts#top", 99]]));
    expect(out.filter((l) => l.kind === "expand").map((l) => l.gap?.key)).toEqual(["a.ts#bottom"]);
  });

  it("leaves the diff untouched when the file has no content to expand", () => {
    expect(withExpansions({ path: "a.ts", content: "" }, lines, new Map())).toEqual(lines);
  });
});
