import { execFile, spawn } from "node:child_process";

import type { Shell } from "./types.js";

/**
 * Widened past `ErrnoException` on purpose: `execFile` reports `code` as
 * `string | number | null`, `spawn` as `string`, and both mean the same thing
 * here — the binary was never found.
 */
const missing = (err: { code?: string | number | null; message: string }): boolean =>
  err.code === "ENOENT" || /ENOENT|not found/i.test(err.message);

/**
 * The real process seam.
 *
 * A binary that is absent resolves to `null` rather than throwing, because the
 * legs treat "you don't have VS Code" and "the install refused" as different
 * situations — one is a skip, the other a failure worth an exit code.
 */
export const nodeShell: Shell = {
  run: async (cmd, args) =>
    new Promise<number | null>((resolve) => {
      // Inherited stdio: an npm install prints its own progress, and reprinting it
      // through us would only lose colour and ordering.
      const child = spawn(cmd, args, { stdio: "inherit" });
      child.on("error", (err: NodeJS.ErrnoException) => {
        resolve(missing(err) ? null : 1);
      });
      child.on("exit", (code) => {
        resolve(code ?? 1);
      });
    }),

  capture: async (cmd, args) =>
    new Promise<string | null>((resolve) => {
      execFile(cmd, args, { encoding: "utf8" }, (err, stdout) => {
        if (err !== null && missing(err)) {
          resolve(null);
          return;
        }
        resolve(err === null ? stdout : null);
      });
    }),
};
