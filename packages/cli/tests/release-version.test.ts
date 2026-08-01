import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain ESM release script, no type declarations by design
import { stampVersion } from "../../../scripts/set-extension-version.mjs";

let repo: string;

const json = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repo, path), "utf8")) as Record<string, unknown>;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rvz-release-"));
  mkdirSync(join(repo, "packages", "extension"), { recursive: true });
  mkdirSync(join(repo, "plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(repo, "packages", "extension", "package.json"),
    `${JSON.stringify({ name: "revizorro", version: "0.0.36", publisher: "artk0de" }, null, 2)}\n`,
  );
  writeFileSync(
    join(repo, "plugin", ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "revizorro", version: "0.9.0", description: "d" }, null, 2)}\n`,
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// `revizorro update` holds all three artifacts against one number. That only
// works if the release stamps all three — a plugin manifest left on its own
// version makes the skill leg compare against something nobody publishes.
describe("stampVersion", () => {
  it("stamps the Claude plugin manifest, so the skill ships in lockstep with the CLI", () => {
    stampVersion(repo, "1.4.0");

    expect(json("plugin/.claude-plugin/plugin.json").version).toBe("1.4.0");
  });

  it("still stamps the VS Code extension manifest", () => {
    stampVersion(repo, "1.4.0");

    expect(json("packages/extension/package.json").version).toBe("1.4.0");
  });

  it("leaves the rest of each manifest untouched", () => {
    stampVersion(repo, "1.4.0");

    expect(json("packages/extension/package.json").publisher).toBe("artk0de");
    expect(json("plugin/.claude-plugin/plugin.json").description).toBe("d");
  });
});

describe("the release configuration", () => {
  const releaserc = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../.releaserc.json", import.meta.url)), "utf8"),
  ) as { plugins: unknown[] };

  it("packages the extension into the CLI before npm publishes it", () => {
    const exec = releaserc.plugins.find(
      (p): p is [string, { prepareCmd: string }] =>
        Array.isArray(p) && p[0] === "@semantic-release/exec",
    );

    expect(exec?.[1].prepareCmd).toContain("vsce package");
    expect(exec?.[1].prepareCmd).toContain("cli/extension.vsix");
  });

  it("commits the plugin manifest, so the stamped version is not lost after the release", () => {
    const git = releaserc.plugins.find(
      (p): p is [string, { assets: string[] }] =>
        Array.isArray(p) && p[0] === "@semantic-release/git",
    );

    expect(git?.[1].assets).toContain("plugin/.claude-plugin/plugin.json");
  });
});
