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
});
