import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Global directory of live review hosts. Each VS Code window with the extension
 * registers its port here so the CLI — which may run from an unrelated terminal —
 * can find a review window regardless of which project (if any) that window has
 * open. Overridable via $REVIZORRO_HOSTS_DIR (tests).
 */
function hostsDir(): string {
  return process.env.REVIZORRO_HOSTS_DIR ?? join(homedir(), ".claude", "revizorro", "hosts");
}

export interface HostEntry {
  port: number;
  /** The window's own project root, for preference matching; "" when it has none. */
  project: string;
}

export function registerHost(port: number, project: string): void {
  const dir = hostsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${port}.json`), JSON.stringify({ port, project }), "utf8");
}

export function unregisterHost(port: number): void {
  try {
    rmSync(join(hostsDir(), `${port}.json`));
  } catch {
    // already gone
  }
}

export function listHosts(): HostEntry[] {
  let names: string[];
  try {
    names = readdirSync(hostsDir());
  } catch {
    return [];
  }
  const out: HostEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const e = JSON.parse(readFileSync(join(hostsDir(), name), "utf8")) as Partial<HostEntry>;
      if (typeof e.port === "number") out.push({ port: e.port, project: e.project ?? "" });
    } catch {
      // corrupt entry — skip
    }
  }
  return out;
}

/**
 * Hosts a CLI targeting `repoRoot` should try, best first: a window that has THIS
 * project open is preferred, then any other window.
 */
export function orderedHosts(repoRoot: string): HostEntry[] {
  return listHosts().sort(
    (a, b) => Number(b.project === repoRoot) - Number(a.project === repoRoot),
  );
}
