// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { el, codeSpan, onSubmit, autoGrow } from "../media/view/dom.js";

describe("el", () => {
  it("builds an element with class and text", () => {
    const e = el("div", "thread open", "hello");
    expect(e.tagName).toBe("DIV");
    expect(e.className).toBe("thread open");
    expect(e.textContent).toBe("hello");
  });

  it("sets text as text, never as markup", () => {
    expect(el("span", undefined, "<b>x</b>").innerHTML).toBe("&lt;b&gt;x&lt;/b&gt;");
  });

  it("leaves text alone when none is given", () => {
    expect(el("div").textContent).toBe("");
  });
});

describe("codeSpan", () => {
  it("renders highlighted markup for a known language", () => {
    expect(codeSpan("const a = 1;", "typescript").querySelector(".hljs-keyword")).not.toBeNull();
  });

  it("escapes code when there is no language", () => {
    expect(codeSpan("<b>", null).textContent).toBe("<b>");
  });
});

describe("onSubmit", () => {
  const press = (ta: HTMLTextAreaElement, init: KeyboardEventInit): void => {
    ta.onkeydown?.(new KeyboardEvent("keydown", { ...init, cancelable: true }));
  };

  it("runs the primary action on Cmd/Ctrl+Enter", () => {
    const ta = document.createElement("textarea");
    const primary = vi.fn();
    const ask = vi.fn();
    onSubmit(ta, primary, ask);
    press(ta, { key: "Enter", metaKey: true });
    expect(primary).toHaveBeenCalledOnce();
    press(ta, { key: "Enter", ctrlKey: true });
    expect(primary).toHaveBeenCalledTimes(2);
    expect(ask).not.toHaveBeenCalled();
  });

  it("runs the ask action when Alt is held too", () => {
    const ta = document.createElement("textarea");
    const primary = vi.fn();
    const ask = vi.fn();
    onSubmit(ta, primary, ask);
    press(ta, { key: "Enter", metaKey: true, altKey: true });
    expect(ask).toHaveBeenCalledOnce();
    expect(primary).not.toHaveBeenCalled();
  });

  it("leaves a plain Enter to insert a newline", () => {
    const ta = document.createElement("textarea");
    const primary = vi.fn();
    onSubmit(ta, primary, vi.fn());
    press(ta, { key: "Enter" });
    expect(primary).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    const ta = document.createElement("textarea");
    const primary = vi.fn();
    onSubmit(ta, primary, vi.fn());
    press(ta, { key: "a", metaKey: true });
    expect(primary).not.toHaveBeenCalled();
  });
});

describe("autoGrow", () => {
  it("resizes the textarea as its content changes", async () => {
    const ta = document.createElement("textarea");
    document.body.append(ta);
    // jsdom reports scrollHeight 0; the observable behaviour is that a height is set.
    autoGrow(ta);
    ta.value = "one\ntwo\nthree";
    ta.dispatchEvent(new Event("input"));
    expect(ta.style.height).toMatch(/px$/);
  });
});
