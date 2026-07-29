// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  scopeLabel,
  changeTotals,
  reviewProgress,
  renderSummary,
  renderBranch,
  renderAgentStatus,
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

describe("renderAgentStatus", () => {
  beforeEach(() => {
    document.body.innerHTML = `<span id="agent"></span>`;
  });
  const status = (): { text: string; cls: string } => {
    const box = document.getElementById("agent");
    return { text: box?.textContent ?? "", cls: box?.className ?? "" };
  };

  // Asking the agent takes it OUT of the poll — it is off writing the answer. That
  // is the busiest the loop ever is, and reading it as "not listening" is wrong.
  it("reports the questions being answered ahead of the poll state", () => {
    renderAgentStatus(false, 1);
    expect(status().text).toContain("answering 1 question");
    expect(status().cls).toContain("busy");
  });

  it("pluralises several open questions", () => {
    renderAgentStatus(false, 3);
    expect(status().text).toContain("answering 3 questions");
  });

  it("says listening while an agent is blocked on the review", () => {
    renderAgentStatus(true, 0);
    expect(status().text).toContain("listening");
    expect(status().cls).toContain("waiting");
  });

  it("warns only when nothing is waiting and nothing is being answered", () => {
    renderAgentStatus(false, 0);
    expect(status().text).toContain("not listening");
    expect(status().cls).toContain("gone");
  });

  it("still reports answering even if the agent re-armed meanwhile", () => {
    renderAgentStatus(true, 2);
    expect(status().text).toContain("answering 2 questions");
  });

  it("shows nothing until the state is known", () => {
    renderAgentStatus(undefined, 0);
    expect(status().text).toBe("");
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

  it("shows the branch under review", () => {
    document.body.innerHTML = '<span id="branch"></span>';
    renderBranch("feature/idle-semantics");
    const node = document.getElementById("branch")!;
    expect(node.textContent).toContain("feature/idle-semantics");
    expect(node.style.display).not.toBe("none");
  });

  it("hides the branch label when the branch is unknown", () => {
    document.body.innerHTML = '<span id="branch"></span>';
    renderBranch("");
    expect(document.getElementById("branch")?.style.display).toBe("none");
  });

  it("survives a toolbar with no branch element", () => {
    document.body.innerHTML = "";
    expect(() => renderBranch("main")).not.toThrow();
  });
});
