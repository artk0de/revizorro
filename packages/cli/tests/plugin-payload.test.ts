import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Claude plugin payload has to hand the agent the skill, not a pointer to it.
 *
 * Claude Code registers `commands/<name>.md` and `skills/<name>/` under the same
 * `plugin:name`, and the command wins. A command that only says "invoke the
 * skill" then resolves back to itself: the agent receives the stub, never the
 * event loop, and drives the review from guesswork unless it goes digging for
 * SKILL.md on disk. A skill is already invocable as a slash command, so a
 * same-named command adds nothing and hides everything.
 */
const PLUGIN = fileURLToPath(new URL("../../../plugin", import.meta.url));

const entries = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

describe("Claude plugin payload", () => {
  it("ships the revizorro skill", () => {
    expect(existsSync(join(PLUGIN, "skills", "revizorro", "SKILL.md"))).toBe(true);
  });

  it("has no command that shares a skill's name and would shadow it", () => {
    const skills = entries(join(PLUGIN, "skills"));
    const commands = entries(join(PLUGIN, "commands")).map((f) => f.replace(/\.md$/, ""));
    expect(commands.filter((c) => skills.includes(c))).toEqual([]);
  });
});
