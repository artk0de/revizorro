import { describe, it, expect } from "vitest";
import { parseLatest } from "../src/index.js";

// The registry is the only outside opinion this command trusts, and a malformed
// answer must read as "no target" rather than as a version — a garbage target
// would be pinned into every leg.
describe("parseLatest", () => {
  it("reads the version out of the dist-tag document npm serves", () => {
    expect(parseLatest('{"name":"@revizorro/cli","version":"1.4.0"}')).toBe("1.4.0");
  });

  it("returns null when the body is not JSON at all", () => {
    expect(parseLatest("<html>502 Bad Gateway</html>")).toBeNull();
  });

  it("returns null when the document carries no version", () => {
    expect(parseLatest('{"error":"Not found"}')).toBeNull();
  });

  it("returns null when the version is not a string, so a number cannot be pinned", () => {
    expect(parseLatest('{"version":140}')).toBeNull();
  });
});
