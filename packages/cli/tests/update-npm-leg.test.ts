import { describe, it, expect } from "vitest";
import { npmLeg } from "../src/index.js";
import type { Shell } from "../src/index.js";

const never: Shell = {
  run: async () => {
    throw new Error("no command should have been spawned");
  },
  capture: async () => null,
};

const spawns = (code: number | null, seen: string[][]): Shell => ({
  run: async (cmd, args) => {
    seen.push([cmd, ...args]);
    return code;
  },
  capture: async () => null,
});

describe("the npm CLI leg", () => {
  it("reports current without spawning anything when the running CLI is already the target", async () => {
    const r = await npmLeg({ currentVersion: "1.4.0", shell: never })("1.4.0");

    expect(r).toEqual({ leg: "cli", state: "current", version: "1.4.0" });
  });

  it("installs the target globally and reports the version it moved from", async () => {
    const seen: string[][] = [];

    const r = await npmLeg({ currentVersion: "1.3.0", shell: spawns(0, seen) })("1.4.0");

    expect(seen).toEqual([["npm", "install", "-g", "@revizorro/cli@1.4.0"]]);
    expect(r).toEqual({ leg: "cli", state: "updated", from: "1.3.0", to: "1.4.0" });
  });

  it("carries npm's own exit code out when the install did not take", async () => {
    const r = await npmLeg({ currentVersion: "1.3.0", shell: spawns(243, []) })("1.4.0");

    expect(r.state).toBe("failed");
    expect(r.state === "failed" && r.exitCode).toBe(243);
  });

  // 127 is the shell's own code for "command not found"; reusing it means a
  // caller scripting around `revizorro update` reads the failure without parsing text.
  it("reports 127 when npm is not on PATH at all", async () => {
    const r = await npmLeg({ currentVersion: "1.3.0", shell: spawns(null, []) })("1.4.0");

    expect(r.state).toBe("failed");
    expect(r.state === "failed" && r.exitCode).toBe(127);
  });

  // A linked checkout is somebody working ON revizorro. `npm install -g` would
  // silently replace their link with a published copy and take the working tree
  // out of the loop — a destructive surprise from a command that reads as routine.
  it("stands down when the CLI is running from a linked dev checkout, instead of replacing the link", async () => {
    const seen: string[][] = [];

    const r = await npmLeg({ currentVersion: "1.3.0", shell: spawns(0, seen), linked: true })(
      "1.4.0",
    );

    expect(seen).toEqual([]);
    expect(r.state).toBe("skipped");
  });
});
