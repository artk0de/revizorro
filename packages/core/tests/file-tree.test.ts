import { describe, it, expect } from "vitest";
import { buildFileTree } from "../src/index.js";

describe("buildFileTree", () => {
  it("keeps root-level files as leaves", () => {
    const tree = buildFileTree(["README.md", "LICENSE"]);
    expect(tree).toEqual([
      { kind: "file", name: "LICENSE", path: "LICENSE", children: [] },
      { kind: "file", name: "README.md", path: "README.md", children: [] },
    ]);
  });

  it("groups files under their directory, directories first", () => {
    const tree = buildFileTree(["src/b.ts", "README.md", "src/a.ts"]);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(["dir:src", "file:README.md"]);
    expect(tree[0].path).toBe("src");
    expect(tree[0].children.map((n) => n.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("collapses a chain of single-child directories into one node", () => {
    const tree = buildFileTree(["packages/core/src/round.ts"]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: "dir", name: "packages/core/src", path: "packages/core/src" });
    expect(tree[0].children.map((n) => n.name)).toEqual(["round.ts"]);
  });

  it("stops collapsing where a directory branches", () => {
    const tree = buildFileTree(["a/b/x.ts", "a/c/y.ts"]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("a");
    expect(tree[0].children.map((n) => n.name)).toEqual(["b", "c"]);
    expect(tree[0].children[0].children.map((n) => n.path)).toEqual(["a/b/x.ts"]);
  });

  it("does not collapse a directory that also holds a file", () => {
    const tree = buildFileTree(["a/README.md", "a/b/x.ts"]);
    expect(tree[0].name).toBe("a");
    expect(tree[0].children.map((n) => `${n.kind}:${n.name}`)).toEqual(["dir:b", "file:README.md"]);
  });

  it("returns nothing for an empty diff", () => {
    expect(buildFileTree([])).toEqual([]);
  });
});
