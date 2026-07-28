// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  scopeLabel,
  changeTotals,
  reviewProgress,
  renderSummary,
  type SummaryFile,
} from "../media/view/summary.js";

const file = (over: Partial<SummaryFile> = {}): SummaryFile => ({
  patch: "@@ -1,1 +1,2 @@\n ctx\n+added\n-removed\n",
  binary: false,
  viewed: false,
  threads: [],
  ...over,
});

describe("scopeLabel", () => {
  it("names the staged scope", () => {
    expect(scopeLabel({ stagedOnly: true, baseRef: "" })).toBe("staged only");
  });

  it("names the target branch for a whole-branch review", () => {
    expect(scopeLabel({ stagedOnly: false, baseRef: "develop" })).toBe("branch vs develop");
    expect(scopeLabel({ stagedOnly: false, baseRef: "" })).toBe("branch vs default branch");
  });

  it("falls back for a session that carries no scope", () => {
    expect(scopeLabel(undefined)).toBe("branch vs default branch");
  });
});

describe("changeTotals", () => {
  it("sums added and removed lines across files", () => {
    expect(changeTotals([file(), file()])).toEqual({ files: 2, add: 2, del: 2 });
  });

  it("counts a binary file without trying to read its patch", () => {
    expect(changeTotals([file({ binary: true, patch: "Binary files differ" })])).toEqual({
      files: 1,
      add: 0,
      del: 0,
    });
  });

  it("handles an empty review", () => {
    expect(changeTotals([])).toEqual({ files: 0, add: 0, del: 0 });
  });
});

describe("reviewProgress", () => {
  it("counts a viewed file with nothing open as done", () => {
    expect(reviewProgress([file({ viewed: true }), file()])).toEqual({ done: 1, total: 2, pct: 50 });
  });

  it("does not count a viewed file that still has an unresolved thread", () => {
    const s = reviewProgress([file({ viewed: true, threads: [{ resolved: false }] })]);
    expect(s.done).toBe(0);
  });

  it("counts a viewed file whose threads are all resolved", () => {
    expect(reviewProgress([file({ viewed: true, threads: [{ resolved: true }] })]).done).toBe(1);
  });

  it("reports 0% rather than dividing by zero on an empty review", () => {
    expect(reviewProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
  });
});

describe("renderSummary", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span id="scope"></span><span id="stats"></span>
      <span id="progress"><span id="progressBar"></span><span id="progressLabel"></span></span>`;
  });

  it("paints scope, totals and progress", () => {
    renderSummary([file({ viewed: true }), file()], { stagedOnly: true, baseRef: "" });
    expect(document.getElementById("scope")?.textContent).toBe("staged only");
    expect(document.getElementById("stats")?.textContent).toBe("2 files +2 −2");
    expect(document.getElementById("progressLabel")?.textContent).toBe("1/2 reviewed");
    expect(document.getElementById("progressBar")?.style.width).toBe("50%");
  });

  it("marks the bar full only when every file is done", () => {
    renderSummary([file({ viewed: true })], { stagedOnly: true, baseRef: "" });
    expect(document.getElementById("progressBar")?.classList.contains("full")).toBe(true);
  });

  it("hides the progress widget when there is nothing to review", () => {
    renderSummary([], { stagedOnly: false, baseRef: "main" });
    expect(document.getElementById("progress")?.style.display).toBe("none");
  });

  it("survives a toolbar that lacks the elements", () => {
    document.body.innerHTML = "";
    expect(() => {
      renderSummary([file()], undefined);
    }).not.toThrow();
  });
});
