// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderDiffBody, setRerender, type DiffFile } from "../media/view/diff-body.js";
import type { ThreadView } from "../media/view/thread.js";

const thread = (over: Partial<ThreadView> = {}): ThreadView => ({
  id: "t1",
  line: 2,
  side: "new",
  resolved: false,
  pending: false,
  messages: [{ author: "human", body: "why?" }],
  ...over,
});

// Paths are unique per test: revealed context is remembered per file across renders.
const diffFile = (path: string, threads: ThreadView[] = []): DiffFile => ({
  path,
  // No trailing newline: it would parse as one more context line and close the gap below.
  patch: `@@ -1,2 +1,3 @@\n context\n-gone\n+added\n+more`,
  content: "context\nadded\nmore\ntail\n",
  threads,
});

const mount = (f: DiffFile, mode = "inline"): HTMLElement => {
  const body = renderDiffBody(f, mode);
  document.body.append(body);
  return body;
};

beforeEach(() => {
  document.body.innerHTML = "";
  setRerender(() => {});
});

describe("inline diff body", () => {
  it("anchors a removed-line thread under the removed row, not the added row sharing its number", () => {
    const body = mount(diffFile("a.ts", [thread({ side: "old", line: 2 })]));
    const box = body.querySelector(".thread");
    expect(box?.previousElementSibling?.classList.contains("del")).toBe(true);
  });

  it("opens a composer over a shift-extended line selection", () => {
    const body = mount(diffFile("b.ts"));
    const picks = [...body.querySelectorAll<HTMLElement>(".no.pick")];
    picks[0].click();
    picks[2].dispatchEvent(new MouseEvent("click", { shiftKey: true }));
    expect(body.querySelectorAll(".ln.sel")).toHaveLength(3);

    body.querySelector<HTMLElement>(".ln.add .gut.cm")?.click();
    const ta = document.querySelector<HTMLTextAreaElement>(".compose textarea");
    expect(ta?.placeholder).toContain("lines 1–3");
    // Opening the composer consumes the selection.
    expect(body.querySelectorAll(".ln.sel")).toHaveLength(0);
  });
});

describe("split diff body", () => {
  it("places each thread on its own side of the grid", () => {
    const body = mount(
      diffFile("c.ts", [thread({ id: "o", side: "old", line: 2 }), thread({ id: "n", line: 2 })]),
      "split",
    );
    expect(body.classList.contains("splitgrid")).toBe(true);
    expect(body.querySelector('.thread[data-id="o"]')?.classList.contains("old")).toBe(true);
    expect(body.querySelector('.thread[data-id="n"]')?.classList.contains("new")).toBe(true);
  });
});

describe("expand context", () => {
  it("reveals hidden context through a re-render and keeps it revealed", () => {
    let renders = 0;
    setRerender(() => {
      renders++;
    });
    const f = diffFile("d.ts");
    const row = mount(f).querySelector<HTMLElement>(".expand-row");
    expect(row?.textContent).toBe("↕ expand 1 line");
    row?.click();
    expect(renders).toBe(1);

    const again = renderDiffBody(f, "inline");
    expect(again.querySelector(".expand-row")).toBeNull();
    expect(again.querySelector('.ln[data-line="4"]')?.textContent).toContain("tail");
  });
});
