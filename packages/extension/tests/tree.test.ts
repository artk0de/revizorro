// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  renderTree,
  revealFile,
  fileMarker,
  setTreeVisible,
  bindTreeHotkey,
  isTreeVisible,
  applyTreeWidth,
  resetTree,
  type TreeFile,
} from "../media/view/tree.js";

const file = (path: string, over: Partial<TreeFile> = {}): TreeFile => ({
  path,
  patch: "@@ -1,1 +1,2 @@\n ctx\n+added\n-removed\n",
  binary: false,
  viewed: false,
  threads: [],
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = `<div id="main"><aside id="tree"></aside><div id="files"></div></div>`;
  resetTree();
});

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("#tree .node")];

describe("fileMarker", () => {
  it("puts unresolved work ahead of every done signal", () => {
    const f = file("a.ts", { viewed: true, threads: [{ resolved: true }, { resolved: false }] });
    expect(fileMarker(f)).toMatchObject({ glyph: "●", kind: "open" });
  });

  it("marks a file whose threads are all resolved", () => {
    expect(fileMarker(file("a.ts", { threads: [{ resolved: true }] }))).toMatchObject({
      kind: "done",
    });
  });

  it("marks a viewed file with no threads as seen", () => {
    expect(fileMarker(file("a.ts", { viewed: true }))).toMatchObject({ kind: "seen" });
  });

  it("marks an untouched file as todo", () => {
    expect(fileMarker(file("a.ts"))).toMatchObject({ glyph: "•", kind: "todo" });
  });
});

describe("renderTree", () => {
  it("groups files under collapsed directory chains", () => {
    renderTree([file("packages/core/src/a.ts"), file("packages/core/src/b.ts"), file("README.md")]);
    const labels = rows().map((r) => r.querySelector(".nm")?.textContent);
    expect(labels).toEqual(["packages/core/src", "a.ts", "b.ts", "README.md"]);
  });

  it("shows counts per file and a header summary", () => {
    renderTree([file("a.ts", { threads: [{ resolved: false }] }), file("b.ts", { viewed: true })]);
    expect(document.querySelector("#tree .tree-head")?.textContent).toContain("2 files");
    expect(document.querySelector("#tree .tree-head")?.textContent).toContain("💬1 open");
    const first = rows()[0];
    expect(first.querySelector(".cmt")?.textContent).toContain("💬1");
    expect(first.querySelector(".add")?.textContent).toBe("+1");
    expect(first.querySelector(".del")?.textContent).toBe("−1");
  });

  it("reports how many files are done when nothing is open", () => {
    renderTree([file("a.ts", { viewed: true }), file("b.ts")]);
    expect(document.querySelector("#tree .tree-head .done")?.textContent).toBe("1/2 done");
  });

  it("fades a finished file but keeps one with open work legible", () => {
    renderTree([
      file("done.ts", { viewed: true }),
      file("busy.ts", { viewed: true, threads: [{ resolved: false }] }),
    ]);
    const [busy, done] = rows(); // alphabetical
    expect(busy.classList.contains("attention")).toBe(true);
    expect(busy.classList.contains("viewed")).toBe(false);
    expect(done.classList.contains("viewed")).toBe(true);
  });

  it("marks a renamed file", () => {
    renderTree([file("new.ts", { oldPath: "old.ts" })]);
    expect(rows()[0].classList.contains("moved")).toBe(true);
    expect(rows()[0].title).toContain("old.ts → new.ts");
  });

  it("collapses and re-expands a directory on click", () => {
    renderTree([file("src/a.ts"), file("src/b.ts")]);
    const dir = rows().find((r) => r.classList.contains("dir"));
    dir?.click();
    renderTree([file("src/a.ts"), file("src/b.ts")]);
    expect(document.querySelector<HTMLElement>("#tree .tkids")?.style.display).toBe("none");
    document.querySelector<HTMLElement>("#tree .node.dir")?.click();
    renderTree([file("src/a.ts"), file("src/b.ts")]);
    expect(document.querySelector<HTMLElement>("#tree .tkids")?.style.display).toBe("block");
  });

  it("skips a binary file's line counts", () => {
    renderTree([file("logo.png", { binary: true, patch: "Binary files differ" })]);
    expect(rows()[0].querySelector(".add")).toBeNull();
  });

  it("renders an empty review without failing", () => {
    renderTree([]);
    expect(document.querySelector("#tree .tree-head")?.textContent).toContain("0 files");
  });
});

describe("revealFile", () => {
  beforeEach(() => {
    const card = document.createElement("div");
    card.className = "file";
    card.dataset.path = "a.ts";
    card.innerHTML = `<div class="file-head"><span class="caret">▸</span></div><div class="diff" style="display: none"></div>`;
    document.getElementById("files")?.append(card);
  });

  it("expands the collapsed file it jumps to", () => {
    renderTree([file("a.ts")]);
    rows()[0].click();
    expect(document.querySelector<HTMLElement>(".file .diff")?.style.display).toBe("block");
    expect(document.querySelector(".file .caret")?.textContent).toBe("▾");
  });

  it("does nothing for a path with no card", () => {
    expect(() => {
      revealFile("missing.ts");
    }).not.toThrow();
  });
});

describe("sidebar chrome", () => {
  it("toggles visibility on the layout and the button", () => {
    document.body.insertAdjacentHTML("beforeend", `<button id="treeToggle"></button>`);
    setTreeVisible(false);
    expect(isTreeVisible()).toBe(false);
    expect(document.getElementById("main")?.classList.contains("tree-hidden")).toBe(true);
    setTreeVisible(true);
    expect(document.getElementById("main")?.classList.contains("tree-hidden")).toBe(false);
    expect(document.getElementById("treeToggle")?.classList.contains("on")).toBe(true);
  });

  it("publishes the width as a custom property", () => {
    applyTreeWidth();
    expect(document.getElementById("main")?.style.getPropertyValue("--tree-w")).toBe("17rem");
  });
});

// The tree eats horizontal room on a wide diff, so it gets toggled constantly.
// Reaching for the mouse each time is the friction the hotkey removes.
describe("tree hotkey", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="main"></div><button id="treeToggle"></button><textarea id="ta"></textarea>`;
    bindTreeHotkey();
    setTreeVisible(true);
  });

  it("toggles the tree", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    expect(isTreeVisible()).toBe(false);
  });

  it("stays out of the way while the human is typing", () => {
    document
      .getElementById("ta")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    expect(isTreeVisible()).toBe(true);
  });

  it("ignores the key when a modifier is held, leaving editor shortcuts alone", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", metaKey: true, bubbles: true }));
    expect(isTreeVisible()).toBe(true);
  });

  it("binds once however often it is called", () => {
    bindTreeHotkey();
    bindTreeHotkey();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    expect(isTreeVisible()).toBe(false);
  });
});
