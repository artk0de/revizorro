import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string, dir: string): [string, string] => [
  name,
  fileURLToPath(new URL(`./packages/${dir}/src/index.ts`, import.meta.url)),
];

export default defineConfig({
  test: { include: ["packages/*/tests/**/*.test.ts"], passWithNoTests: true },
  resolve: {
    alias: Object.fromEntries([
      pkg("@revizorro/protocol", "protocol"),
      pkg("@revizorro/core", "core"),
      pkg("@revizorro/core-adapters", "core-adapters"),
      pkg("@revizorro/cli", "cli"),
    ]),
  },
});
