import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REVIEW_TAB_ICON, reviewTabTitle } from "../src/review-tab.js";

/**
 * The editor tab is how the human finds the form among their open files, so it
 * has to say what it is and which round it shows, and carry the extension's mark.
 */
const media = (p: string): string => fileURLToPath(new URL(`../media/${p}`, import.meta.url));

// PNG colour types 4 (grey + alpha) and 6 (RGBA) carry transparency; the IHDR
// chunk puts the colour type at byte 25 of the file.
const hasAlpha = (file: string): boolean => [4, 6].includes(readFileSync(file)[25] ?? -1);

describe("review tab", () => {
  it("names the round it shows", () => {
    expect(reviewTabTitle(1)).toBe("Code Review (Round 1)");
    expect(reviewTabTitle(7)).toBe("Code Review (Round 7)");
  });

  // Two reviews can be open at once, and "Code Review (Round 1)" twice over tells
  // the human nothing about which branch each tab is asking them to approve. The
  // branch leads because a tab title gets truncated from the end.
  it("leads with the branch when it knows one, so two open reviews are told apart", () => {
    expect(reviewTabTitle(2, "feature-a")).toBe("feature-a · Round 2");
    expect(reviewTabTitle(1, "fix/TD-100361-header")).toBe("fix/TD-100361-header · Round 1");
  });

  it("ships an icon for light and dark themes inside the packaged media folder", () => {
    for (const icon of [REVIEW_TAB_ICON.light, REVIEW_TAB_ICON.dark]) {
      expect(icon).toMatch(/\.png$/);
      expect(existsSync(media(icon))).toBe(true);
    }
  });

  // The Marketplace icon is an opaque black square; at tab size on a light theme
  // that reads as a hole in the tab bar, not as the mark.
  it("draws the mark on a transparent background", () => {
    expect(hasAlpha(media(REVIEW_TAB_ICON.light))).toBe(true);
    expect(hasAlpha(media(REVIEW_TAB_ICON.dark))).toBe(true);
  });
});
