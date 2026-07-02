import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHost, unregisterHost, listHosts, orderedHosts } from "../src/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rvz-hosts-"));
  process.env.REVIZORRO_HOSTS_DIR = dir;
});
afterEach(() => {
  delete process.env.REVIZORRO_HOSTS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("host registry", () => {
  it("lists nothing before any host registers", () => {
    expect(listHosts()).toEqual([]);
  });
  it("registers with the owning pid, lists, and unregisters a host", () => {
    registerHost(51000, "/repo/a");
    expect(listHosts()).toEqual([{ port: 51000, project: "/repo/a", pid: process.pid }]);
    unregisterHost(51000);
    expect(listHosts()).toEqual([]);
  });
  it("prunes (deletes) an entry whose owning process is dead", () => {
    // A window that closed/crashed without unregistering leaves a dead-pid entry.
    writeFileSync(join(dir, "51099.json"), JSON.stringify({ port: 51099, project: "/x", pid: 2147483646 }));
    registerHost(51000, "/repo/a"); // live (this test process)
    expect(listHosts().map((h) => h.port)).toEqual([51000]);
    expect(existsSync(join(dir, "51099.json"))).toBe(false);
  });
  it("orders a host that has the target project open first, others after", () => {
    registerHost(51000, "/repo/other");
    registerHost(51001, "/repo/target");
    registerHost(51002, "");
    const ordered = orderedHosts("/repo/target");
    expect(ordered[0]?.port).toBe(51001);
    expect(ordered.map((h) => h.port).sort()).toEqual([51000, 51001, 51002]);
  });
});
