import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The CLI is the only package we publish to npm. Its bundle (esbuild, see the
// build script) inlines every @revizorro/* workspace package, so none of them
// may survive as a runtime dependency: they are never published, and npm would
// 404 on `npm i -g @revizorro/cli`.
const manifest = (name: string): Record<string, any> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${name}/package.json`, import.meta.url)), "utf8"),
  ) as Record<string, any>;

describe("published @revizorro/cli manifest", () => {
  const pkg = manifest("cli");

  it("declares no unpublished workspace package as a runtime dependency", () => {
    const runtime = Object.keys(pkg.dependencies ?? {});
    expect(runtime.filter((d) => d.startsWith("@revizorro/"))).toEqual([]);
  });

  it("pins every runtime dependency to a real range, never the workspace star", () => {
    const ranges: string[] = Object.values(pkg.dependencies ?? {});
    expect(ranges.filter((r) => r === "*")).toEqual([]);
  });

  it("ships the bundle and publishes the scope publicly", () => {
    expect(pkg.files).toContain("dist");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.bin?.revizorro).toBeTruthy();
  });

  // The skill leg of `revizorro update` copies its bytes straight out of the
  // installed package. That only works if the tarball carries them, and it only
  // stays honest if the copy is refreshed by the build rather than by hand.
  it("ships the Claude plugin payload, so the skill leg needs no network round trip", () => {
    expect(pkg.files).toContain("plugin");
  });

  it("refreshes that payload from the build script, so the published copy cannot go stale", () => {
    expect(pkg.scripts?.build).toContain("sync-plugin");
  });

  // The extension travels in the same tarball, so `revizorro update` can install
  // it from disk — no Marketplace listing and no publisher token on the path.
  it("ships the packaged extension, so update installs it without the Marketplace", () => {
    expect(pkg.files).toContain("extension.vsix");
  });

  it("carries the metadata the npm listing renders", () => {
    expect(pkg.description).toBeTruthy();
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository?.url).toContain("github.com/artk0de/revizorro");
    expect(pkg.keywords?.length ?? 0).toBeGreaterThan(0);
  });
});
