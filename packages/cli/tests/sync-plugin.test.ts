import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain ESM build script, no type declarations by design
import { syncPlugin } from "../../../scripts/sync-plugin.mjs";

const SOURCE = fileURLToPath(new URL("../../../plugin", import.meta.url));

/** Relative path -> content digest, so equality means the bytes match, not just the names. */
const digests = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[relative(root, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return out;
};

let dest: string;

beforeEach(() => {
  dest = mkdtempSync(join(tmpdir(), "rvz-sync-"));
});

afterEach(() => {
  rmSync(dest, { recursive: true, force: true });
});

// The skill leg publishes whatever the npm tarball carries. If that copy can
// drift from the plugin the marketplace serves, two people running the same
// version end up with different skills.
describe("syncPlugin", () => {
  it("reproduces the marketplace payload byte for byte", () => {
    syncPlugin(SOURCE, dest);

    expect(digests(dest)).toEqual(digests(SOURCE));
  });

  it("drops a file that vanished from the source, so a deleted skill cannot linger in the tarball", () => {
    writeFileSync(join(dest, "ghost.md"), "removed upstream\n");

    syncPlugin(SOURCE, dest);

    expect(Object.keys(digests(dest))).not.toContain("ghost.md");
  });
});
