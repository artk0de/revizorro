// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A long line must not outgrow its card.
 *
 * Inline rows used to lay code out with `white-space: pre` inside a horizontally
 * scrolling diff: the text ran past the row, while the row's add/del tint, the
 * hunk band and an open composer all stayed at the viewport's width — so
 * scrolling right left the code floating on an unpainted background, detached
 * from the form it was being commented in. Split view already soft-wraps its
 * code columns for exactly this reason; inline has to wrap the same way.
 *
 * jsdom does no layout, so this pins the computed style that prevents the
 * overflow rather than measuring the overflow itself. It loads the real stylesheet
 * from review.html, not a copy of the rules.
 */
const LONG = `expect(json).to include('file_types' => ['pdf'], 'file_size_limit' => ${"Settings.tax_automations.instead.max_file_size_mb".repeat(4)})`;

const send = (viewMode: "inline" | "split"): void => {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "state",
        round: 1,
        status: "open",
        scope: { stagedOnly: false, baseRef: "" },
        viewMode,
        files: [
          {
            path: "spec/connection_spec.rb",
            patch: `@@ -1,2 +1,2 @@ ${LONG}\n context\n-${LONG}\n+${LONG}\n`,
            content: `context\n${LONG}\n`,
            binary: false,
            viewed: false,
            threads: [],
          },
        ],
      },
    }),
  );
};

const wrapping = (e: Element | null): { whiteSpace: string; overflowWrap: string } => {
  expect(e).not.toBeNull();
  const s = getComputedStyle(e as Element);
  return { whiteSpace: s.whiteSpace, overflowWrap: s.getPropertyValue("overflow-wrap") };
};

const SOFT_WRAP = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" };

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
    postMessage: () => undefined,
  });
  const html = readFileSync("packages/extension/media/review.html", "utf8");
  const page = new DOMParser().parseFromString(html, "text/html");
  document.head.innerHTML = page.head.innerHTML;
  document.body.innerHTML = page.body.innerHTML;
  await import("../media/webview.ts");
});

describe("long lines", () => {
  it("soft-wrap in split view", () => {
    send("split");
    expect(wrapping(document.querySelector(".splitgrid .gcode.new"))).toEqual(SOFT_WRAP);
  });

  it("soft-wrap in inline view, the same way split does", () => {
    send("inline");
    expect(wrapping(document.querySelector("#files .ln.add .txt"))).toEqual(SOFT_WRAP);
    expect(wrapping(document.querySelector("#files .ln.del .txt"))).toEqual(SOFT_WRAP);
  });

  it("wrap a long hunk header instead of pushing the row wider than the card", () => {
    send("inline");
    expect(wrapping(document.querySelector("#files .ln.hunk"))).toEqual(SOFT_WRAP);
  });
});
