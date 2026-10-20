// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The webview end to end: feed it a state message and check what lands in the DOM.
 *
 * This is the test that would have caught the render loop dying part-way through —
 * the tree listed every file while only the first few diff cards existed, so the
 * sidebar pointed at cards that were never built.
 */
const posted: unknown[] = [];

const fileView = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  patch: `@@ -1,2 +1,3 @@\n context\n-gone\n+added\n+more\n`,
  content: "context\nadded\nmore\ntail\n",
  binary: false,
  viewed: false,
  threads: [],
  ...over,
});

const send = (files: unknown[], over: Record<string, unknown> = {}): void => {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "state",
        round: 3,
        status: "open",
        scope: { stagedOnly: true, baseRef: "" },
        viewMode: "inline",
        files,
        ...over,
      },
    }),
  );
};

const cards = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>("#files .file[data-path]"),
];
const treeFiles = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>("#tree .node.file"),
];

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => posted.push(m),
  });
  const html = readFileSync("packages/extension/media/review.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
  await import("../media/webview.ts");
});

describe("webview render", () => {
  it("renders a diff card for every file, not just the first few", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `src/dir${i % 3}/file${i}.ts`);
    send(paths.map((p) => fileView(p)));
    expect(cards().map((c) => c.dataset.path)).toEqual(expect.arrayContaining(paths));
    expect(cards()).toHaveLength(paths.length);
  });

  it("keeps the tree and the cards in step", () => {
    send([fileView("a.ts"), fileView("b/c.ts"), fileView("b/d.ts")]);
    expect(treeFiles()).toHaveLength(3);
    expect(cards()).toHaveLength(3);
    // Every sidebar row must point at a card that exists.
    for (const row of treeFiles()) {
      expect(cards().some((c) => c.dataset.path === row.dataset.file)).toBe(true);
    }
  });

  it("renders binary and lockfile entries without breaking the run", () => {
    send([
      fileView("logo.png", { binary: true, patch: "Binary files differ", content: "" }),
      fileView("package-lock.json", { patch: "@@ -1,1 +1,1 @@\n+x\n" }),
      fileView("normal.ts"),
    ]);
    expect(cards()).toHaveLength(3);
    expect(document.querySelector(".file .binary")?.textContent).toContain("binary");
  });

  it("shows a file's threads inside its card", () => {
    send([
      fileView("a.ts", {
        threads: [
          {
            id: "t1",
            line: 1,
            side: "new",
            resolved: false,
            pending: false,
            messages: [{ author: "agent", body: "why this?" }],
          },
        ],
      }),
    ]);
    expect(document.querySelector(".file .thread .msg-body")?.textContent).toContain("why this?");
  });

  it("reports the round and the scope in the toolbar", () => {
    send([fileView("a.ts")]);
    expect(document.getElementById("round")?.textContent).toBe("round 3 · open");
    expect(document.getElementById("scope")?.textContent).toBe("staged only");
  });

  it("says so when there is nothing to review", () => {
    send([]);
    expect(document.querySelector("#files .empty")?.textContent).toContain("no changes");
    expect(cards()).toHaveLength(0);
  });

  it("posts a ready handshake on load", () => {
    expect(posted).toContainEqual({ type: "ready" });
  });

  // A pure deletion has no new-side line to anchor to, so without a gutter on the
  // removed line there is nowhere to say "why did this go?" — the review has no
  // way to question a deletion at all.
  it("lets you comment on a removed line", () => {
    send([fileView("a.ts")]);
    const removed = document.querySelector<HTMLElement>("#files .ln.del");
    expect(removed).not.toBeNull();
    expect(removed?.querySelector(".gut")?.textContent).toBe("💬");
  });

  it("anchors a thread left on a removed line to the old side", () => {
    send([
      fileView("a.ts", {
        threads: [
          {
            id: "t9",
            line: 2,
            side: "old",
            resolved: false,
            pending: false,
            messages: [{ author: "human", body: "why was this dropped?" }],
          },
        ],
      }),
    ]);
    expect(document.querySelector(".file .thread .msg-body")?.textContent).toContain(
      "why was this dropped?",
    );
  });
});

// Every push from the extension rebuilds the form, and a card used to re-derive its
// fold from `viewed` / `resolved` alone — so a file opened by hand to comment on
// snapped shut whenever the agent or the host sent anything.
describe("folds survive a re-render", () => {
  const diffOf = (path: string): HTMLElement =>
    cards()
      .find((c) => c.dataset.path === path)!
      .querySelector<HTMLElement>(".diff")!;
  const resolvedThread = (id: string) => ({
    id,
    line: 2,
    side: "new",
    resolved: true,
    pending: false,
    messages: [{ author: "human", body: "done" }],
  });

  it("keeps a viewed file open after the human opened it", () => {
    send([fileView("seen.ts", { viewed: true })]);
    expect(diffOf("seen.ts").style.display).toBe("none");
    cards()[0].querySelector<HTMLElement>(".file-head")!.click();
    send([fileView("seen.ts", { viewed: true })], { agentWaiting: true });
    expect(diffOf("seen.ts").style.display).toBe("block");
  });

  it("keeps a viewed file open after a jump from the tree", () => {
    send([fileView("jumped.ts", { viewed: true })]);
    treeFiles()[0].click();
    send([fileView("jumped.ts", { viewed: true })]);
    expect(diffOf("jumped.ts").style.display).toBe("block");
  });

  it("still folds a file the human has just ticked as viewed", () => {
    send([fileView("tick.ts")]);
    cards()[0].querySelector<HTMLElement>(".file-head")!.click();
    cards()[0].querySelector<HTMLElement>(".file-head")!.click();
    cards()[0].querySelector<HTMLInputElement>(".viewed-chk input")!.click();
    send([fileView("tick.ts", { viewed: true })]);
    expect(diffOf("tick.ts").style.display).toBe("none");
  });

  it("keeps a resolved thread open after the human opened it", () => {
    send([fileView("t.ts", { threads: [resolvedThread("r1")] })]);
    const content = () =>
      document.querySelector<HTMLElement>('.thread[data-id="r1"] .thread-content')!;
    expect(content().style.display).toBe("none");
    document.querySelector<HTMLElement>('.thread[data-id="r1"] .thread-bar')!.click();
    send([fileView("t.ts", { threads: [resolvedThread("r1")] })]);
    expect(content().style.display).toBe("block");
  });
});
