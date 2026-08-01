import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillLeg } from "../src/index.js";

let root: string;
let payload: string;

const registry = (doc: unknown): void => {
  writeFileSync(join(root, "installed_plugins.json"), JSON.stringify(doc, null, 2));
};

const readRegistry = (): Record<string, any> =>
  JSON.parse(readFileSync(join(root, "installed_plugins.json"), "utf8")) as Record<string, any>;

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  scope: "user",
  installPath: join(root, "cache", "revizorro", "revizorro", "0.9.0"),
  version: "0.9.0",
  installedAt: "2026-01-01T00:00:00.000Z",
  lastUpdated: "2026-01-01T00:00:00.000Z",
  gitCommitSha: "deadbeef",
  ...over,
});

const leg = (): ReturnType<typeof skillLeg> =>
  skillLeg({ pluginsRoot: root, payloadDir: payload, now: () => "2026-08-01T12:00:00.000Z" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rvz-plugins-"));
  mkdirSync(join(root, "cache", "revizorro", "revizorro", "0.9.0", ".in_use"), { recursive: true });
  writeFileSync(join(root, "cache", "revizorro", "revizorro", "0.9.0", ".in_use", "4242"), "");

  payload = mkdtempSync(join(tmpdir(), "rvz-payload-"));
  mkdirSync(join(payload, ".claude-plugin"), { recursive: true });
  mkdirSync(join(payload, "skills", "revizorro"), { recursive: true });
  writeFileSync(join(payload, ".claude-plugin", "plugin.json"), '{"name":"revizorro"}\n');
  writeFileSync(join(payload, "skills", "revizorro", "SKILL.md"), "# fresh skill\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(payload, { recursive: true, force: true });
});

// This leg writes into Claude Code's own plugin state, which carries no public
// contract. Every precondition below is a refusal to guess: a machine that never
// had Claude, a registry shape we do not recognise, or a plugin the human never
// installed are all reasons to stand down rather than invent state.
describe("the Claude skill leg", () => {
  it("skips when Claude Code was never installed here, because there is no cache to write into", async () => {
    rmSync(root, { recursive: true, force: true });

    const r = await leg()("1.4.0");

    expect(r.state).toBe("skipped");
  });

  it("skips when the human never installed the revizorro plugin, instead of installing it for them", async () => {
    registry({ version: 2, plugins: { "superpowers@claude-plugins-official": [entry()] } });

    const r = await leg()("1.4.0");

    expect(r).toEqual({
      leg: "skill",
      state: "skipped",
      reason: "the revizorro plugin is not installed in Claude Code",
    });
  });

  // Silently skipping an unknown schema would mean the skill quietly stops being
  // updated forever. Failing loudly is the only way that ever gets noticed.
  it("refuses to write when the registry schema is not the one it knows, naming the version it found", async () => {
    registry({ version: 3, plugins: { "revizorro@revizorro": [entry()] } });

    const r = await leg()("1.4.0");

    expect(r.state).toBe("failed");
    expect(r.state === "failed" && r.reason).toContain("3");
  });

  it("reports current when the installed entry already carries the target version", async () => {
    registry({ version: 2, plugins: { "revizorro@revizorro": [entry({ version: "1.4.0" })] } });

    const r = await leg()("1.4.0");

    expect(r).toEqual({ leg: "skill", state: "current", version: "1.4.0" });
  });

  it("copies the payload into a fresh version directory and repoints the registry at it", async () => {
    registry({ version: 2, plugins: { "revizorro@revizorro": [entry()] } });

    const r = await leg()("1.4.0");

    const fresh = join(root, "cache", "revizorro", "revizorro", "1.4.0");
    expect(r).toEqual({ leg: "skill", state: "updated", from: "0.9.0", to: "1.4.0" });
    expect(readFileSync(join(fresh, "skills", "revizorro", "SKILL.md"), "utf8")).toBe(
      "# fresh skill\n",
    );
    expect(readRegistry().plugins["revizorro@revizorro"][0]).toMatchObject({
      installPath: fresh,
      version: "1.4.0",
      lastUpdated: "2026-08-01T12:00:00.000Z",
    });
  });

  // Live Claude sessions register themselves by dropping a PID file into the
  // version directory they loaded. Deleting it out from under them would swap the
  // code a running session is executing.
  it("leaves the previous version directory alone, because live sessions hold PID markers in it", async () => {
    registry({ version: 2, plugins: { "revizorro@revizorro": [entry()] } });

    await leg()("1.4.0");

    expect(existsSync(join(root, "cache", "revizorro", "revizorro", "0.9.0", ".in_use", "4242"))).toBe(
      true,
    );
  });

  it("preserves fields it does not understand when rewriting the entry", async () => {
    registry({
      version: 2,
      plugins: { "revizorro@revizorro": [entry({ somethingClaudeAddedLater: "keep me" })] },
    });

    await leg()("1.4.0");

    expect(readRegistry().plugins["revizorro@revizorro"][0].somethingClaudeAddedLater).toBe(
      "keep me",
    );
  });
});
