import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { LegResult, UpdateLeg } from "./types.js";

export interface SkillLegDeps {
  /** Claude Code's plugin state root — `~/.claude/plugins` in production. */
  pluginsRoot: string;
  /** Plugin payload shipped inside the installed npm package. */
  payloadDir: string;
  /** Injected so the registry timestamp is assertable. */
  now: () => string;
}

interface RegistryEntry {
  installPath?: string;
  version?: string;
  lastUpdated?: string;
  [field: string]: unknown;
}

interface Registry {
  version?: number;
  plugins?: Record<string, RegistryEntry[]>;
  [field: string]: unknown;
}

const MARKETPLACE = "revizorro";
const PLUGIN = "revizorro";
const KEY = `${PLUGIN}@${MARKETPLACE}`;
/** The only `installed_plugins.json` shape this code knows how to edit. */
const SCHEMA = 2;

const skipped = (reason: string): LegResult => ({ leg: "skill", state: "skipped", reason });
const failed = (reason: string): LegResult => ({ leg: "skill", state: "failed", reason });

/**
 * Publishes the plugin payload the npm package carries into Claude Code's cache.
 *
 * Taking the bytes from the installed package rather than fetching them makes the
 * skill version equal to the CLI version by construction — they came out of one
 * tarball — and costs no network call, no API rate limit, no repo access.
 *
 * Everything here writes into state Claude Code owns and does not document, so
 * the code refuses rather than guesses whenever the ground looks unfamiliar.
 */
export function skillLeg(deps: SkillLegDeps): UpdateLeg {
  return async (target) => {
    if (!existsSync(deps.pluginsRoot)) return skipped("Claude Code is not installed");

    const registryPath = join(deps.pluginsRoot, "installed_plugins.json");
    if (!existsSync(registryPath)) return skipped("Claude Code has no plugin registry yet");

    let doc: Registry;
    try {
      doc = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
    } catch {
      return failed(`${registryPath} is not valid JSON`);
    }

    // An unrecognised schema means a write could corrupt the list of every plugin
    // the human has installed. Refusing loudly is the only outcome that gets
    // noticed; skipping would let the skill silently rot for good.
    if (doc.version !== SCHEMA) {
      return failed(
        `the Claude plugin registry is schema ${String(doc.version)}, and this build only ` +
          `understands ${SCHEMA} — refusing to write`,
      );
    }

    const entries = doc.plugins?.[KEY];
    if (!Array.isArray(entries) || entries.length === 0) {
      return skipped("the revizorro plugin is not installed in Claude Code");
    }

    const from = String(entries[0].version ?? "unknown");
    if (from === target) return { leg: "skill", state: "current", version: target };

    const versions = join(deps.pluginsRoot, "cache", MARKETPLACE, PLUGIN);
    const dest = join(versions, target);
    mkdirSync(versions, { recursive: true });

    // Stage beside the target and rename, so a session that reads the cache mid-copy
    // never sees a half-written skill. The previous version directory is left
    // untouched: live sessions register themselves by PID inside it.
    const staging = mkdtempSync(join(versions, `.staging-${target}-`));
    try {
      cpSync(deps.payloadDir, staging, { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      renameSync(staging, dest);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      return failed(`could not publish the skill into ${dest}: ${(err as Error).message}`);
    }

    // Mutating the parsed document rather than rebuilding it keeps every field
    // Claude may have added and this build has never heard of.
    for (const e of entries) {
      e.installPath = dest;
      e.version = target;
      e.lastUpdated = deps.now();
    }
    const staged = `${registryPath}.revizorro-tmp`;
    writeFileSync(staged, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(staged, registryPath);

    return { leg: "skill", state: "updated", from, to: target };
  };
}
