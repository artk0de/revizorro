// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { markMatches, clearMarks } from "../media/view/find.js";

const root = (): HTMLElement => document.getElementById("files")!;

beforeEach(() => {
  document.body.innerHTML = `<div id="files"></div>`;
});

const html = (s: string): void => {
  root().innerHTML = s;
};

describe("markMatches", () => {
  it("wraps every occurrence, case-insensitively", () => {
    html(`<span>const Session = session();</span>`);
    const hits = markMatches(root(), "session");
    expect(hits).toHaveLength(2);
    expect(root().querySelectorAll("mark.find-hit")).toHaveLength(2);
    expect(hits[0].textContent).toBe("Session");
  });

  it("leaves the surrounding text intact", () => {
    html(`<span>alpha beta gamma</span>`);
    markMatches(root(), "beta");
    expect(root().textContent).toBe("alpha beta gamma");
  });

  it("returns hits in reading order across elements", () => {
    html(`<div><span>one xy</span><span>two xy</span></div>`);
    const hits = markMatches(root(), "xy");
    expect(hits).toHaveLength(2);
    expect(hits[0].closest("span")?.textContent).toContain("one");
  });

  it("ignores a query too short to be worth highlighting", () => {
    html(`<span>aaaa</span>`);
    expect(markMatches(root(), "a")).toEqual([]);
    expect(markMatches(root(), "  ")).toEqual([]);
  });

  it("stays out of fields the human is typing in", () => {
    html(`<textarea>needle</textarea><span>needle</span>`);
    expect(markMatches(root(), "needle")).toHaveLength(1);
  });

  it("searches a collapsed file, which is the point of searching at all", () => {
    html(`<div class="file"><div class="diff" style="display:none"><span>needle</span></div></div>`);
    expect(markMatches(root(), "needle")).toHaveLength(1);
  });

  it("re-running replaces the previous highlight instead of nesting it", () => {
    html(`<span>needle needle</span>`);
    markMatches(root(), "needle");
    const hits = markMatches(root(), "needle");
    expect(hits).toHaveLength(2);
    expect(root().querySelectorAll("mark.find-hit")).toHaveLength(2);
    expect(root().querySelectorAll("mark.find-hit mark")).toHaveLength(0);
  });

  it("treats a regex-looking query as literal text", () => {
    html(`<span>a.b and axb</span>`);
    expect(markMatches(root(), "a.b")).toHaveLength(1);
  });
});

describe("clearMarks", () => {
  it("restores the original text", () => {
    html(`<span>alpha beta</span>`);
    markMatches(root(), "beta");
    clearMarks(root());
    expect(root().querySelectorAll("mark.find-hit")).toHaveLength(0);
    expect(root().innerHTML).toBe(`<span>alpha beta</span>`);
  });
});
