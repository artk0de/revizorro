import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Marketplace listing requirements. vsce only warns about most of these, so a
// missing icon or category ships a grey, uncategorised extension nobody finds.
const root = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));
const pkg = JSON.parse(readFileSync(root("package.json"), "utf8")) as Record<string, any>;

describe("VS Code Marketplace manifest", () => {
  it("names a publisher and a supported engine range", () => {
    expect(pkg.publisher).toBeTruthy();
    expect(pkg.engines?.vscode).toBeTruthy();
  });

  it("points at an icon that exists inside the packaged folder", () => {
    expect(pkg.icon).toBeTruthy();
    expect(existsSync(root(pkg.icon as string))).toBe(true);
  });

  it("declares categories and keywords so search can surface it", () => {
    expect(pkg.categories?.length ?? 0).toBeGreaterThan(0);
    expect(pkg.keywords?.length ?? 0).toBeGreaterThan(0);
  });

  it("links back to the repository, issues and homepage", () => {
    expect(pkg.repository?.url).toContain("github.com/artk0de/revizorro");
    expect(pkg.bugs?.url).toBeTruthy();
    expect(pkg.homepage).toBeTruthy();
  });

  it("excludes sources and build inputs from the vsix", () => {
    const ignore = readFileSync(root(".vscodeignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    for (const entry of ["src/**", "tests/**", "media/**/*.ts", "tsconfig.json"]) {
      expect(ignore).toContain(entry);
    }
  });

  it("renders standalone on the Marketplace — no repo-relative links in the README", () => {
    const readme = readFileSync(root("README.md"), "utf8");
    const relative = [...readme.matchAll(/]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1]);
    expect(relative).toEqual([]);
  });
});
