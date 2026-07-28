// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { setBridge } from "../media/view/bridge.js";
import { trackActivity } from "../media/view/activity.js";

describe("form activity ping", () => {
  let sent: unknown[];
  beforeEach(() => {
    sent = [];
    setBridge((m) => sent.push(m));
  });

  it("reports the first interaction immediately", () => {
    const target = document.createElement("div");
    trackActivity(target);
    target.dispatchEvent(new Event("pointerdown"));
    expect(sent).toEqual([{ type: "activity" }]);
  });

  it("collapses a burst of interaction into one report", () => {
    const target = document.createElement("div");
    trackActivity(target);
    for (let i = 0; i < 20; i++) target.dispatchEvent(new Event("keydown"));
    expect(sent).toEqual([{ type: "activity" }]);
  });

  it("reports again once the throttle window has passed", () => {
    const target = document.createElement("div");
    let clock = 1_000_000;
    trackActivity(target, () => clock);
    target.dispatchEvent(new Event("keydown"));
    clock += 30_001;
    target.dispatchEvent(new Event("keydown"));
    expect(sent).toHaveLength(2);
  });

  it("says nothing while nobody touches the form", () => {
    trackActivity(document.createElement("div"));
    expect(sent).toEqual([]);
  });
});
