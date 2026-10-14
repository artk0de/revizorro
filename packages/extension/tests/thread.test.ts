// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { setBridge } from "../media/view/bridge.js";
import { resetDrafts } from "../media/view/drafts.js";
import {
  renderThread,
  openCompose,
  openComposeAt,
  reopenCompose,
  type ThreadView,
} from "../media/view/thread.js";

// jsdom has no CSS namespace; the webview's browser does, and anchors are looked up through it.
(globalThis as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s) => s };

let posted: unknown[] = [];

const thread = (over: Partial<ThreadView> = {}): ThreadView => ({
  id: "t1",
  line: 3,
  side: "new",
  resolved: false,
  pending: false,
  messages: [
    { author: "human", body: "why?" },
    { author: "agent", body: "because" },
  ],
  ...over,
});

/** A rendered diff row carrying the comment anchor a composer attaches after. */
const anchorRow = (file: string, line: number): HTMLElement => {
  const row = document.createElement("div");
  row.className = "ln ctx";
  row.dataset.file = file;
  row.dataset.line = String(line);
  document.body.append(row);
  return row;
};

const click = (root: ParentNode, selector: string): void => {
  root.querySelector<HTMLElement>(selector)?.click();
};

beforeEach(() => {
  document.body.innerHTML = "";
  posted = [];
  setBridge((m) => posted.push(m));
  resetDrafts();
  // Drop any composer a previous test left as the one to reopen.
  openCompose(anchorRow("reset.ts", 1), "reset.ts", 1, 1, "new");
  click(document, ".compose .cancel");
  document.body.innerHTML = "";
});

describe("renderThread", () => {
  it("renders the root comment and replies, with a reply box while open", () => {
    const box = renderThread(thread());
    expect(box.dataset.id).toBe("t1");
    expect(box.querySelectorAll(".msg")).toHaveLength(2);
    expect(box.querySelectorAll(".msg.reply")).toHaveLength(1);
    expect(box.querySelector(".status")?.textContent).toBe("2 comment(s)");
    expect(box.querySelector(".reply-box")).not.toBeNull();
    // Only your own posts are editable.
    expect(box.querySelectorAll(".icon-edit")).toHaveLength(1);
  });

  it("collapses a resolved thread and offers no reply box or edits", () => {
    const box = renderThread(thread({ resolved: true }));
    expect(box.querySelector<HTMLElement>(".thread-content")?.style.display).toBe("none");
    expect(box.querySelector(".reply-box")).toBeNull();
    expect(box.querySelector(".icon-edit")).toBeNull();
  });

  it("shows the agent is replying while the thread is pending", () => {
    expect(renderThread(thread({ pending: true })).querySelector(".loader")).not.toBeNull();
  });

  it("flips the resolved flag through the bridge", () => {
    click(renderThread(thread()), ".thread-bar button");
    expect(posted).toEqual([{ type: "resolve", threadId: "t1", resolved: true }]);
  });

  it("posts a trimmed reply and empties the box", () => {
    const box = renderThread(thread());
    const ta = box.querySelector<HTMLTextAreaElement>(".reply-box textarea");
    if (!ta) throw new Error("no reply box");
    ta.value = "  sure  ";
    click(box, ".reply-box button");
    expect(posted).toEqual([{ type: "reply", threadId: "t1", body: "sure" }]);
    expect(ta.value).toBe("");
  });
});

describe("composer", () => {
  it("keeps a single composer open and carries the selected code into the comment", () => {
    openCompose(anchorRow("a.ts", 2), "a.ts", 2, 2, "new");
    openCompose(anchorRow("a.ts", 5), "a.ts", 4, 5, "old", "x = 1");
    expect(document.querySelectorAll(".compose")).toHaveLength(1);
    const ta = document.querySelector<HTMLTextAreaElement>(".compose textarea");
    if (!ta) throw new Error("no composer");
    ta.value = "rename";
    click(document, ".compose .compose-actions button");
    expect(posted).toEqual([
      {
        type: "comment",
        file: "a.ts",
        side: "old",
        startLine: 4,
        endLine: 5,
        body: "```\nx = 1\n```\n\nrename",
      },
    ]);
    expect(document.querySelector(".compose")).toBeNull();
  });

  it("reopens the open composer after the diff is rebuilt, and not after it was closed", () => {
    openComposeAt("b.ts", 7, 7, "new");
    expect(document.querySelector(".compose")).toBeNull();

    openCompose(anchorRow("b.ts", 7), "b.ts", 7, 7, "new");
    document.body.innerHTML = "";
    anchorRow("b.ts", 7);
    reopenCompose();
    expect(document.querySelector(".compose textarea")).not.toBeNull();

    click(document, ".compose .cancel");
    document.body.innerHTML = "";
    anchorRow("b.ts", 7);
    reopenCompose();
    expect(document.querySelector(".compose")).toBeNull();
  });
});
