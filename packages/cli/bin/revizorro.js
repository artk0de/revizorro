#!/usr/bin/env node
import { join } from "node:path";
import { runCli } from "@revizorro/cli";

// esbuild emits CJS, where `import.meta.url` is undefined but `__dirname` is real.
// The bundle lives in dist/, so its package.json — and the plugin payload beside
// it — are one level up.
const packageRoot = join(__dirname, "..");

async function main() {
  const { stdout, exitCode } = await runCli(process.argv.slice(2), packageRoot);
  if (stdout) process.stdout.write(`${stdout}\n`);
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`revizorro: ${err.message ?? err}\n`);
  process.exit(1);
});
