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
  /** Extension-host process id — used to prune entries whose window has died. */
  pid: number;
}

/** True if a process with `pid` still exists (signal 0 is an existence probe). */
function pidAlive(pid: number): boolean {
  if (!pid) return true; // legacy entry without a pid — keep it, let the CLI probe.
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (dead window); EPERM = alive but owned elsewhere.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function registerHost(port: number, project: string): void {
  const dir = hostsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${port}.json`), JSON.stringify({ port, project, pid: process.pid }), "utf8");
}

export function unregisterHost(port: number): void {
  try {
    rmSync(join(hostsDir(), `${port}.json`));
  } catch {
    // already gone
  }
}

/**
 * Live hosts, self-healing: any entry whose owning process is gone is pruned on
 * read, so a closed/reloaded/crashed window never lingers as a stale candidate —
 * the root cause of "stale port" errors, not just papered over at connect time.
 */
export function listHosts(): HostEntry[] {
  const dir = hostsDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: HostEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let e: Partial<HostEntry>;
    try {
      e = JSON.parse(readFileSync(file, "utf8")) as Partial<HostEntry>;
    } catch {
      rmSync(file, { force: true }); // corrupt entry — drop it
      continue;
    }
    if (typeof e.port !== "number") {
      rmSync(file, { force: true });
      continue;
    }
    const pid = typeof e.pid === "number" ? e.pid : 0;
    if (!pidAlive(pid)) {
      rmSync(file, { force: true }); // owning window is dead — prune proactively
      continue;
    }
    out.push({ port: e.port, project: e.project ?? "", pid });
  }
  return out;
}

/** Drop a trailing slash so "/repo/x/" and "/repo/x" compare equal. */
function normalizePath(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

/** True when `child` is the same path as `parent` or lives inside it. */
function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * How strongly a window owns the reviewed repo — higher wins. A worktree or a
 * subdirectory still belongs to the project's window, which is what makes the form
 * appear where the human is looking instead of in some unrelated window.
 */
function affinity(project: string, repoRoot: string): number {
  const win = normalizePath(project);
  const repo = normalizePath(repoRoot);
  if (!win) return 0;
  if (win === repo) return 3;
  if (contains(win, repo)) return 2; // reviewing a worktree / subdir of that window's project
  if (contains(repo, win)) return 1; // window sits on a subdirectory of the reviewed repo
  return 0;
}

/** True when this window has the reviewed project (or a parent/child of it) open. */
export function hostMatchesProject(host: HostEntry, repoRoot: string): boolean {
  return affinity(host.project, repoRoot) > 0;
}

/**
 * Hosts a CLI targeting `repoRoot` should try, best first: the window owning THIS
 * project (exactly, or as the parent of the reviewed worktree) comes first, any
 * other window after — ordered by port so the choice is never left to readdir.
 */
export function orderedHosts(repoRoot: string): HostEntry[] {
  return listHosts().sort(
    (a, b) => affinity(b.project, repoRoot) - affinity(a.project, repoRoot) || a.port - b.port,
  );
}
