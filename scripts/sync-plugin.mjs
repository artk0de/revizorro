#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Mirrors the Claude plugin payload into the published CLI package.
 *
 * `revizorro update` writes the skill into Claude's cache from the bytes the npm
 * package carries, which keeps the skill version equal to the CLI version by
 * construction and costs no network call. That only holds while the copy is an
 * exact mirror, so this wipes the destination first: a file deleted upstream must
 * not survive in the tarball.
 */
export function syncPlugin(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const root = join(dirname(self), "..");
  syncPlugin(join(root, "plugin"), join(root, "packages", "cli", "plugin"));
}
