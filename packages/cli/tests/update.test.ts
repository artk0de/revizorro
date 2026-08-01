import { describe, it, expect } from "vitest";
import { runUpdate } from "../src/index.js";
import type { UpdateLeg } from "../src/index.js";

// One number governs the whole install: whatever npm calls `latest` for the CLI.
// Every leg is held against that number rather than updated blindly, so running
// the command on an already-consistent set costs nothing and spawns nothing.
describe("runUpdate", () => {
  const leg =
    (name: string, seen: string[]): UpdateLeg =>
    async (target) => {
      seen.push(`${name}@${target}`);
      return { leg: name, state: "current", version: target };
    };

  it("touches nothing and exits 0 when every leg already sits on the registry target", async () => {
    const seen: string[] = [];
    const r = await runUpdate({
      fetchLatest: async () => "1.4.0",
      legs: [leg("cli", seen), leg("skill", seen), leg("extension", seen)],
    });

    expect(seen).toEqual(["cli@1.4.0", "skill@1.4.0", "extension@1.4.0"]);
    expect(r.exitCode).toBe(0);
  });

  it("leaves every leg alone when the registry never answered, so a blip cannot half-update the set", async () => {
    const seen: string[] = [];
    const r = await runUpdate({
      fetchLatest: async () => null,
      legs: [leg("cli", seen), leg("skill", seen), leg("extension", seen)],
    });

    expect(seen).toEqual([]);
    expect(r.exitCode).toBe(1);
  });

  it("reports what happened to each leg on its own line", async () => {
    const r = await runUpdate({
      fetchLatest: async () => "1.4.0",
      legs: [
        async () => ({ leg: "cli", state: "updated", from: "1.3.0", to: "1.4.0" }),
        async () => ({ leg: "skill", state: "current", version: "1.4.0" }),
        async () => ({ leg: "extension", state: "skipped", reason: "`code` is not in PATH" }),
      ],
    });

    expect(r.stdout.split("\n")).toEqual([
      "cli: 1.3.0 → 1.4.0",
      "skill: 1.4.0 (already current)",
      "extension: skipped — `code` is not in PATH",
    ]);
  });

  // A leg that had nothing to do is not a failure: no VS Code on the machine, or
  // a Claude plugin the human never installed, both leave the set consistent.
  it("still exits 0 when a leg skipped, because skipping is not failing", async () => {
    const r = await runUpdate({
      fetchLatest: async () => "1.4.0",
      legs: [
        async () => ({ leg: "cli", state: "current", version: "1.4.0" }),
        async () => ({ leg: "skill", state: "skipped", reason: "Claude Code is not installed" }),
      ],
    });

    expect(r.exitCode).toBe(0);
  });

  it("exits 1 and keeps going when one leg fails, so the others still get reconciled", async () => {
    const seen: string[] = [];
    const r = await runUpdate({
      fetchLatest: async () => "1.4.0",
      legs: [
        async () => ({ leg: "cli", state: "failed", reason: "npm exited 1" }),
        leg("skill", seen),
      ],
    });

    expect(seen).toEqual(["skill@1.4.0"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("cli: failed — npm exited 1");
  });

  // A caller scripting around this command should be able to tell "npm is not
  // installed" from "npm ran and refused" without parsing the message text.
  it("surfaces a leg's own exit code rather than flattening every failure to 1", async () => {
    const r = await runUpdate({
      fetchLatest: async () => "1.4.0",
      legs: [async () => ({ leg: "cli", state: "failed", reason: "npm is not on PATH", exitCode: 127 })],
    });

    expect(r.exitCode).toBe(127);
  });
});
