// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  unresolvedThreadIds,
  stepId,
  stepIndex,
  jumpTo,
  threadElement,
  renderThreadNav,
} from "../media/view/navigate.js";

/** A review with two files, the first collapsed, threads in diff order. */
const layout = `
  <div class="toolbar"></div>
  <div id="files">
    <div class="file" data-path="a.ts">
      <div class="file-head"><span class="caret">▸</span></div>
      <div class="diff" style="display: none">
        <div class="thread" data-id="t1"><div class="thread-content"></div></div>
        <div class="thread resolved" data-id="t2"><div class="thread-content" style="display: none"></div></div>
      </div>
    </div>
    <div class="file" data-path="b.ts">
      <div class="file-head"><span class="caret">▾</span></div>
      <div class="diff" style="display: block">
        <div class="thread" data-id="t3"><div class="thread-content"></div></div>
      </div>
    </div>
  </div>`;

beforeEach(() => {
  document.body.innerHTML = layout;
});

describe("unresolvedThreadIds", () => {
  it("walks only open threads, in diff order", () => {
    expect(unresolvedThreadIds()).toEqual(["t1", "t3"]);
  });

  it("returns nothing once every thread is resolved", () => {
    for (const t of document.querySelectorAll(".thread")) t.classList.add("resolved");
    expect(unresolvedThreadIds()).toEqual([]);
  });
});

describe("stepId", () => {
  it("starts at the first thread going forward and the last going back", () => {
    expect(stepId(["a", "b", "c"], null, 1)).toBe("a");
    expect(stepId(["a", "b", "c"], null, -1)).toBe("c");
  });

  it("wraps around both ends", () => {
    expect(stepId(["a", "b", "c"], "c", 1)).toBe("a");
    expect(stepId(["a", "b", "c"], "a", -1)).toBe("c");
  });

  it("treats a cursor the page no longer knows at all as no position", () => {
    expect(stepId(["a", "b"], "gone", 1)).toBe("a");
  });

  it("has nowhere to go in an empty review", () => {
    expect(stepId([], null, 1)).toBeNull();
  });

  // Resolving is how a reader finishes with a thread, so it is the most common
  // moment to press "next". Diff order — resolved threads included — is what keeps
  // the cursor's place once the thread under it drops out of the open list.
  describe("after the thread under the cursor is resolved", () => {
    const all = ["t1", "t2", "t3", "t4", "t5"];

    it("moves on to the thread after it, rather than back to the top", () => {
      expect(stepId(["t1", "t2", "t4", "t5"], "t3", 1, all)).toBe("t4");
    });

    it("steps back to the open thread before it", () => {
      expect(stepId(["t1", "t2", "t4", "t5"], "t3", -1, all)).toBe("t2");
    });

    it("carries on past a whole run of resolved threads", () => {
      expect(stepId(["t1", "t5"], "t3", 1, all)).toBe("t5");
    });

    it("still wraps when nothing open is left below it", () => {
      expect(stepId(["t1", "t2"], "t5", 1, all)).toBe("t1");
    });
  });
});

describe("stepIndex", () => {
  it("wraps over a hit count", () => {
    expect(stepIndex(3, -1, 1)).toBe(0);
    expect(stepIndex(3, 2, 1)).toBe(0);
    expect(stepIndex(3, 0, -1)).toBe(2);
    expect(stepIndex(0, -1, 1)).toBe(-1);
  });
});

// Nothing to walk means nothing to show: a control reading 0/0 is chrome that
// asks to be clicked and then does nothing.
describe("renderThreadNav", () => {
  beforeEach(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<span class="nav" id="threadNav"><span class="navpos" id="threadPos"></span></span>`,
    );
  });

  const pos = (): string => document.getElementById("threadPos")!.textContent ?? "";
  const hidden = (): boolean => document.getElementById("threadNav")!.hasAttribute("hidden");

  it("counts the open threads and where the human stands", () => {
    renderThreadNav(["a", "b", "c"], "b");
    expect(pos()).toBe("2/3");
    expect(hidden()).toBe(false);
  });

  // Resolving a thread must not throw the reader back to the start of the list.
  // The cursor keeps its place in diff order, so the position it reports is the
  // number of open threads up to and including where it stands.
  it("holds the cursor's place when the thread under it is resolved", () => {
    renderThreadNav(["a", "c"], "b", ["a", "b", "c"]);
    expect(pos()).toBe("1/2");
  });

  it("shows the total before the first jump", () => {
    renderThreadNav(["a", "b"], null);
    expect(pos()).toBe("0/2");
  });

  it("disappears entirely once every thread is resolved", () => {
    renderThreadNav(["a"], "a");
    renderThreadNav([], "a");
    expect(hidden()).toBe(true);
    expect(pos()).toBe("");
  });

  it("comes back when a new thread opens", () => {
    renderThreadNav([], null);
    renderThreadNav(["a"], null);
    expect(hidden()).toBe(false);
    expect(pos()).toBe("0/1");
  });
});

describe("jumpTo", () => {
  it("opens the collapsed file it lands in", () => {
    jumpTo(threadElement("t1")!);
    const card = document.querySelector<HTMLElement>('.file[data-path="a.ts"]');
    expect(card?.querySelector<HTMLElement>(".diff")?.style.display).toBe("block");
    expect(card?.querySelector(".caret")?.textContent).toBe("▾");
  });

  it("opens a collapsed thread body, so the comment is actually readable", () => {
    const target = threadElement("t2")!;
    jumpTo(target);
    expect(target.querySelector<HTMLElement>(".thread-content")?.style.display).toBe("block");
  });

  it("scrolls clear of the toolbar and the pinned file header", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", { value: scrollTo, writable: true });
    Object.defineProperty(window, "scrollY", { value: 100, writable: true });
    const target = threadElement("t3")!;
    target.getBoundingClientRect = () => ({ top: 300 }) as DOMRect;
    document.querySelector(".toolbar")!.getBoundingClientRect = () => ({ height: 40 }) as DOMRect;
    document.querySelector('.file[data-path="b.ts"] .file-head')!.getBoundingClientRect = () =>
      ({ height: 30 }) as DOMRect;

    jumpTo(target);

    // 300 (viewport) + 100 (already scrolled) − 40 − 30 − 8 breathing room
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 322 }));
  });

  it("marks where it landed so the eye finds it", () => {
    jumpTo(threadElement("t3")!);
    expect(document.querySelectorAll(".jump-flash")).toHaveLength(1);
    jumpTo(threadElement("t1")!);
    expect(document.querySelectorAll(".jump-flash")).toHaveLength(1);
  });

  it("survives a target that belongs to no file card", () => {
    const orphan = document.createElement("div");
    document.body.append(orphan);
    expect(() => {
      jumpTo(orphan);
    }).not.toThrow();
  });
});
