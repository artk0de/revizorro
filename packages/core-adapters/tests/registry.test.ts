import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
  it("registers, lists, and unregisters a host", () => {
    registerHost(51000, "/repo/a");
    expect(listHosts()).toEqual([{ port: 51000, project: "/repo/a" }]);
    unregisterHost(51000);
    expect(listHosts()).toEqual([]);
  });
  it("orders a host that has the target project open first, others after", () => {
    registerHost(51000, "/repo/other");
    registerHost(51001, "/repo/target");
    registerHost(51002, "");
    const ordered = orderedHosts("/repo/target");
    expect(ordered[0]).toEqual({ port: 51001, project: "/repo/target" });
    expect(ordered.map((h) => h.port).sort()).toEqual([51000, 51001, 51002]);
  });
});
