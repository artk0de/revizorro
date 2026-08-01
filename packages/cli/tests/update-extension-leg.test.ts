import { describe, it, expect } from "vitest";
import { extensionLeg } from "../src/index.js";
import type { Shell } from "../src/index.js";

const shell = (listing: string | null, code: number | null, seen: string[][] = []): Shell => ({
  capture: async () => listing,
  run: async (cmd, args) => {
    seen.push([cmd, ...args]);
    return code;
  },
});

const LISTING = ["ms-python.python@2024.1.0", "artk0de.revizorro@1.3.0"].join("\n");

describe("the VS Code extension leg", () => {
  it("skips when the VS Code CLI is not on PATH, since the editor cannot be reached from here", async () => {
    const r = await extensionLeg({ shell: shell(null, 0) })("1.4.0");

    expect(r.state).toBe("skipped");
  });

  // `update` is not `install`. An editor extension the human never chose is not
  // this command's to add, the same way it does not install the Claude plugin.
  it("skips when the extension was never installed, rather than adding it unasked", async () => {
    const r = await extensionLeg({ shell: shell("ms-python.python@2024.1.0", 0) })("1.4.0");

    expect(r).toEqual({
      leg: "extension",
      state: "skipped",
      reason: "the revizorro extension is not installed in VS Code",
    });
  });

  it("reports current when the installed extension already carries the target", async () => {
    const r = await extensionLeg({ shell: shell("artk0de.revizorro@1.4.0", 0) })("1.4.0");

    expect(r).toEqual({ leg: "extension", state: "current", version: "1.4.0" });
  });

  it("installs the pinned target and reports the version it moved from", async () => {
    const seen: string[][] = [];

    const r = await extensionLeg({ shell: shell(LISTING, 0, seen) })("1.4.0");

    expect(seen).toEqual([
      ["code", "--install-extension", "artk0de.revizorro@1.4.0", "--force"],
    ]);
    expect(r).toEqual({ leg: "extension", state: "updated", from: "1.3.0", to: "1.4.0" });
  });

  it("fails when the install command came back non-zero", async () => {
    const r = await extensionLeg({ shell: shell(LISTING, 1) })("1.4.0");

    expect(r.state).toBe("failed");
  });
});
