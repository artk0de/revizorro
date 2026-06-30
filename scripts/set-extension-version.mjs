// Sync the released version into the VS Code extension manifest so vsce publishes
// the same version semantic-release computed for the CLI. Invoked by
// @semantic-release/exec prepareCmd: `node scripts/set-extension-version.mjs <version>`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
  console.error("usage: set-extension-version.mjs <version>");
  process.exit(1);
}

const manifest = fileURLToPath(new URL("../packages/extension/package.json", import.meta.url));
const pkg = JSON.parse(readFileSync(manifest, "utf8"));
pkg.version = version;
writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`extension version -> ${version}`);
