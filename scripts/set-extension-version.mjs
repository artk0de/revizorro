// Sync the released version into every manifest that is not npm's, so the CLI,
// the VS Code extension and the Claude plugin all carry the one version
// semantic-release computed. Invoked by @semantic-release/exec prepareCmd:
// `node scripts/set-extension-version.mjs <version>`.
//
// `revizorro update` reconciles those three artifacts against a single number.
// A manifest left unstamped makes that number unreachable for its leg.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Rewrite one manifest's `version`, leaving every other field as it was. */
function stampManifest(path, version) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  doc.version = version;
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

export function stampVersion(repoRoot, version) {
  stampManifest(join(repoRoot, "packages", "extension", "package.json"), version);
  console.log(`extension version -> ${version}`);

  stampManifest(join(repoRoot, "plugin", ".claude-plugin", "plugin.json"), version);
  console.log(`claude plugin version -> ${version}`);

  // The Marketplace renders a CHANGELOG tab from a file inside the packaged
  // folder. @semantic-release/changelog wrote the real one at the repo root a
  // moment ago (its prepare runs before ours), so mirror it in.
  const changelog = join(repoRoot, "CHANGELOG.md");
  if (existsSync(changelog)) {
    copyFileSync(changelog, join(repoRoot, "packages", "extension", "CHANGELOG.md"));
    console.log("extension CHANGELOG.md <- root CHANGELOG.md");
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: set-extension-version.mjs <version>");
    process.exit(1);
  }
  stampVersion(join(dirname(self), ".."), version);
}
