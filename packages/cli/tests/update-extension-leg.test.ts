import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionLeg } from "../src/index.js";
import type { Shell } from "../src/index.js";

let carried: string;
let vsix: string;

const shell = (listing: string | null, code: number | null, seen: string[][] = []): Shell => ({
  capture: async () => listing,
  run: async (cmd, args) => {
    seen.push([cmd, ...args]);
    return code;
  },
});

const LISTING = ["ms-python.python@2024.1.0", "artk0de.revizorro@1.3.0"].join("\n");

beforeEach(() => {
  carried = mkdtempSync(join(tmpdir(), "rvz-vsix-"));
  vsix = join(carried, "revizorro.vsix");
  writeFileSync(vsix, "PK pretend archive");
});

afterEach(() => {
  rmSync(carried, { recursive: true, force: true });
});

// The extension is installed from the VSIX the CLI package carries, not from the
// Marketplace. One tarball then holds all three artifacts at one version, and
// the update path needs neither a Marketplace listing nor a publisher token.
describe("the VS Code extension leg", () => {
  it("skips when the VS Code CLI is not on PATH, since the editor cannot be reached from here", async () => {
    const r = await extensionLeg({ shell: shell(null, 0), vsixPath: vsix })("1.4.0");

    expect(r.state).toBe("skipped");
  });

  // `update` is not `install`. An editor extension the human never chose is not
  // this command's to add, the same way it does not install the Claude plugin.
  it("skips when the extension was never installed, rather than adding it unasked", async () => {
    const r = await extensionLeg({
      shell: shell("ms-python.python@2024.1.0", 0),
      vsixPath: vsix,
    })("1.4.0");

    expect(r).toEqual({
      leg: "extension",
      state: "skipped",
      reason: "the revizorro extension is not installed in VS Code",
    });
  });

  it("reports current when the installed extension already carries the target", async () => {
    const r = await extensionLeg({ shell: shell("artk0de.revizorro@1.4.0", 0), vsixPath: vsix })(
      "1.4.0",
    );

    expect(r).toEqual({ leg: "extension", state: "current", version: "1.4.0" });
  });

  it("installs the VSIX the CLI package carries instead of reaching for the Marketplace", async () => {
    const seen: string[][] = [];

    const r = await extensionLeg({ shell: shell(LISTING, 0, seen), vsixPath: vsix })("1.4.0");

    expect(seen).toEqual([["code", "--install-extension", vsix, "--force"]]);
    expect(r).toEqual({ leg: "extension", state: "updated", from: "1.3.0", to: "1.4.0" });
  });

  // A local build does not package the extension; only a release does. Saying so
  // beats spawning `code` with a path to nothing and reading back its complaint.
  it("skips when the package carries no VSIX, because there is nothing to install from", async () => {
    const seen: string[][] = [];

    const r = await extensionLeg({
      shell: shell(LISTING, 0, seen),
      vsixPath: join(carried, "absent.vsix"),
    })("1.4.0");

    expect(seen).toEqual([]);
    expect(r.state).toBe("skipped");
  });

  it("fails when the install command came back non-zero", async () => {
    const r = await extensionLeg({ shell: shell(LISTING, 1), vsixPath: vsix })("1.4.0");

    expect(r.state).toBe("failed");
  });
});
