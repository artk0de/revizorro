// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  bindDraft,
  getDraft,
  setDraft,
  clearDraft,
  markEditorOpen,
  markEditorClosed,
  isEditorOpen,
  focusSnapshot,
  restoreFocus,
  resetDrafts,
} from "../media/view/drafts.js";

const textarea = (): HTMLTextAreaElement => {
  const ta = document.createElement("textarea");
  document.body.append(ta);
  return ta;
};

beforeEach(() => {
  document.body.innerHTML = "";
  resetDrafts();
});

describe("draft storage", () => {
  it("remembers typed text and forgets emptied text", () => {
    setDraft("k", "half a sentence");
    expect(getDraft("k")).toBe("half a sentence");
    setDraft("k", "");
    expect(getDraft("k")).toBeUndefined();
  });

  it("clears a draft explicitly on submit", () => {
    setDraft("k", "sent");
    clearDraft("k");
    expect(getDraft("k")).toBeUndefined();
  });
});

describe("bindDraft", () => {
  it("records what the human types", () => {
    const ta = textarea();
    bindDraft(ta, "reply:t1");
    ta.value = "typing…";
    ta.dispatchEvent(new Event("input"));
    expect(getDraft("reply:t1")).toBe("typing…");
  });

  it("restores the draft into a freshly built textarea", () => {
    setDraft("reply:t1", "survived the re-render");
    const rebuilt = textarea();
    bindDraft(rebuilt, "reply:t1");
    expect(rebuilt.value).toBe("survived the re-render");
  });

  it("leaves a textarea with no draft untouched", () => {
    const ta = textarea();
    ta.value = "prefilled body";
    bindDraft(ta, "edit:t1:0");
    expect(ta.value).toBe("prefilled body");
  });

  it("keeps drafts of different fields apart", () => {
    const a = textarea();
    const b = textarea();
    bindDraft(a, "reply:t1");
    bindDraft(b, "reply:t2");
    a.value = "for one";
    a.dispatchEvent(new Event("input"));
    expect(getDraft("reply:t2")).toBeUndefined();
    expect(b.value).toBe("");
  });
});

describe("open editors", () => {
  it("tracks which editors must reopen after a re-render", () => {
    markEditorOpen("edit:t1:0");
    expect(isEditorOpen("edit:t1:0")).toBe(true);
    expect(isEditorOpen("edit:t1:1")).toBe(false);
  });

  it("forgets an editor and its draft once it closes", () => {
    markEditorOpen("edit:t1:0");
    setDraft("edit:t1:0", "abandoned");
    markEditorClosed("edit:t1:0");
    expect(isEditorOpen("edit:t1:0")).toBe(false);
    expect(getDraft("edit:t1:0")).toBeUndefined();
  });
});

describe("focus", () => {
  it("captures the focused field and caret, and puts them back", () => {
    const ta = textarea();
    bindDraft(ta, "reply:t1");
    ta.value = "hello world";
    ta.dispatchEvent(new Event("input")); // typing, so the draft is recorded
    ta.focus();
    ta.setSelectionRange(5, 5);

    const snap = focusSnapshot();
    expect(snap).toEqual({ key: "reply:t1", start: 5, end: 5 });

    // The re-render: same key, brand-new element.
    document.body.innerHTML = "";
    const rebuilt = textarea();
    bindDraft(rebuilt, "reply:t1");
    restoreFocus(snap);
    expect(document.activeElement).toBe(rebuilt);
    expect(rebuilt.selectionStart).toBe(5);
  });

  it("captures nothing when focus is not in a draft field", () => {
    const plain = document.createElement("textarea");
    document.body.append(plain);
    plain.focus();
    expect(focusSnapshot()).toBeNull();
  });

  it("does nothing when the field is gone after the re-render", () => {
    expect(() => {
      restoreFocus({ key: "reply:vanished", start: 0, end: 0 });
    }).not.toThrow();
  });
});
