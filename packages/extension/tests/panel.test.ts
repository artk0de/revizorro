import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionState } from "@revizorro/protocol";
import type { DiffFile } from "@revizorro/core";
import type { ReviewActions } from "../src/panel.js";

/**
 * The review tab's constructor wires the webview to ONE review: it builds the panel,
 * injects the form's script, and routes every message the form sends to the action it
 * names. None of that runs without VS Code, so the editor is faked down to the parts
 * the tab touches and the wiring is pinned through it.
 */
interface FakePanel {
  title: string;
  iconPath?: unknown;
  active: boolean;
  webview: {
    html: string;
    postMessage: ReturnType<typeof vi.fn>;
    receive: (m: object) => void;
  };
  disposed: number;
  dispose: () => void;
}

const fake = vi.hoisted(() => ({
  created: [] as { args: unknown[]; panel: FakePanel }[],
  clipboard: [] as string[],
}));

vi.mock("vscode", () => ({
  ViewColumn: { Active: -1 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  env: {
    clipboard: {
      writeText: async (t: string) => {
        fake.clipboard.push(t);
      },
    },
  },
  window: {
    createWebviewPanel: (...args: unknown[]) => {
      let onMessage: (m: object) => void = () => undefined;
      let onDispose: () => void = () => undefined;
      const panel = {
        title: "",
        active: false,
        disposed: 0,
        webview: {
          html: "",
          postMessage: vi.fn(async () => true),
          onDidReceiveMessage: (cb: (m: object) => void) => {
            onMessage = cb;
          },
          receive: (m: object) => {
            onMessage(m);
          },
        },
        onDidDispose: (cb: () => void) => {
          onDispose = cb;
        },
        // VS Code fires onDidDispose from dispose(), whoever calls it.
        dispose: () => {
          panel.disposed++;
          onDispose();
        },
      };
      fake.created.push({ args, panel });
      return panel;
    },
  },
}));

const { ReviewPanel } = await import("../src/panel.js");
const { REVIEW_TAB_ICON } = await import("../src/review-tab.js");

const actions = (): {
  [K in keyof ReviewActions]: ReturnType<typeof vi.fn>;
} => ({
  isPending: vi.fn((id: string) => id === "t2"),
  branch: vi.fn(() => "feature-a"),
  isAgentWaiting: vi.fn(() => true),
  noteActivity: vi.fn(),
  approve: vi.fn(async () => undefined),
  requestChanges: vi.fn(async () => undefined),
  clarify: vi.fn(async () => undefined),
  abandon: vi.fn(async () => undefined),
  addHumanComment: vi.fn(async () => undefined),
  addHumanReply: vi.fn(async () => undefined),
  editMessage: vi.fn(async () => undefined),
  resolveThread: vi.fn(async () => undefined),
  setViewed: vi.fn(async () => undefined),
});

const state: SessionState = {
  worktreeId: "wt1",
  round: 3,
  status: "open",
  files: { "a.ts": { viewed: true } },
  threads: [
    {
      id: "t2",
      file: "a.ts",
      side: "new",
      range: { startLine: 4, endLine: 5 },
      messages: [{ author: "human", body: "why?" }],
      resolved: false,
    },
  ],
} as unknown as SessionState;
const diff: DiffFile[] = [{ path: "a.ts", patch: "@@ -1 +1 @@" } as DiffFile];

let mediaDir: string;
let acts: ReturnType<typeof actions>;
let disposed: boolean[];

const build = (): FakePanel => {
  new ReviewPanel(acts, mediaDir, (decided) => disposed.push(decided));
  const last = fake.created.at(-1);
  if (!last) throw new Error("no webview panel was created");
  return last.panel;
};

beforeEach(() => {
  fake.created.length = 0;
  fake.clipboard.length = 0;
  disposed = [];
  acts = actions();
  mediaDir = mkdtempSync(join(tmpdir(), "rvz-panel-"));
  writeFileSync(
    join(mediaDir, "review.html"),
    "<body><script>// <!--WEBVIEW_JS--></script></body>",
  );
  // A literal "</script>" would end the inline block early, and "$&" is a
  // replacement pattern a plain string replace would expand.
  writeFileSync(join(mediaDir, "webview.js"), "const a = '</script>'; const b = '$&';");
});

describe("ReviewPanel construction", () => {
  it("opens a scripted, retained, searchable webview in the active column", () => {
    build();
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]?.args).toEqual([
      "revizorroReview",
      "Code Review",
      -1,
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
    ]);
  });

  it("carries the tab icon for both themes from the media folder", () => {
    const panel = build();
    expect(panel.iconPath).toEqual({
      light: { fsPath: join(mediaDir, REVIEW_TAB_ICON.light) },
      dark: { fsPath: join(mediaDir, REVIEW_TAB_ICON.dark) },
    });
  });

  it("inlines the form script verbatim, with closing script tags escaped", () => {
    const panel = build();
    expect(panel.webview.html).toBe(
      "<body><script>const a = '<\\/script>'; const b = '$&';</script></body>",
    );
  });

  it("posts nothing on construction", () => {
    const panel = build();
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe("ReviewPanel closing", () => {
  it("treats a close without a verdict as abandoning the review", () => {
    const panel = build();
    panel.dispose();
    expect(disposed).toEqual([false]);
    expect(acts.abandon).toHaveBeenCalledTimes(1);
  });

  it("approves, then closes as decided without abandoning", () => {
    const panel = build();
    panel.webview.receive({ type: "approve" });
    expect(acts.approve).toHaveBeenCalledTimes(1);
    expect(panel.disposed).toBe(1);
    expect(disposed).toEqual([true]);
    expect(acts.abandon).not.toHaveBeenCalled();
  });

  it("requests changes, then closes as decided without abandoning", () => {
    const panel = build();
    panel.webview.receive({ type: "requestChanges" });
    expect(acts.requestChanges).toHaveBeenCalledTimes(1);
    expect(panel.disposed).toBe(1);
    expect(disposed).toEqual([true]);
    expect(acts.abandon).not.toHaveBeenCalled();
  });

  it("keeps the tab open on clarify", () => {
    const panel = build();
    panel.webview.receive({ type: "clarify" });
    expect(acts.clarify).toHaveBeenCalledTimes(1);
    expect(panel.disposed).toBe(0);
  });
});

describe("ReviewPanel message routing", () => {
  it("replays the last state on ready, and nothing before one was rendered", () => {
    const panel = build();
    panel.webview.receive({ type: "ready" });
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    const tab = new ReviewPanel(acts, mediaDir, () => undefined);
    const second = fake.created.at(-1)?.panel;
    tab.render(state, diff);
    second?.webview.receive({ type: "ready" });
    expect(second?.webview.postMessage).toHaveBeenCalledTimes(2);
    expect(second?.webview.postMessage.mock.calls[1]).toEqual(
      second?.webview.postMessage.mock.calls[0],
    );
  });

  it("copies text through the host clipboard, and ignores an empty copy", () => {
    const panel = build();
    panel.webview.receive({ type: "copy", text: "snippet" });
    panel.webview.receive({ type: "copy" });
    expect(fake.clipboard).toEqual(["snippet"]);
  });

  it("forwards reader activity", () => {
    const panel = build();
    panel.webview.receive({ type: "activity" });
    expect(acts.noteActivity).toHaveBeenCalledTimes(1);
  });

  it("toggles the view mode and reposts the last state with it", () => {
    const panel = build();
    // Without a rendered state there is nothing to repost.
    panel.webview.receive({ type: "toggleViewMode" });
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    const tab = new ReviewPanel(acts, mediaDir, () => undefined);
    const second = fake.created.at(-1)?.panel;
    tab.render(state, diff);
    second?.webview.receive({ type: "toggleViewMode" });
    second?.webview.receive({ type: "toggleViewMode" });
    const modes = second?.webview.postMessage.mock.calls.map(
      (c) => (c[0] as { viewMode: string }).viewMode,
    );
    expect(modes).toEqual(["inline", "split", "inline"]);
  });

  it("marks a file viewed, coercing the flag", () => {
    const panel = build();
    panel.webview.receive({ type: "setViewed", file: "a.ts", viewed: true });
    panel.webview.receive({ type: "setViewed", file: "b.ts" });
    panel.webview.receive({ type: "setViewed" });
    expect(acts.setViewed.mock.calls).toEqual([
      ["a.ts", true],
      ["b.ts", false],
    ]);
  });

  it("opens a thread from comment and ask, defaulting to the new side", () => {
    const panel = build();
    panel.webview.receive({ type: "comment", file: "a.ts", startLine: 1, endLine: 2, body: "x" });
    panel.webview.receive({
      type: "ask",
      file: "a.ts",
      side: "old",
      startLine: 3,
      endLine: 3,
      body: "y",
    });
    // Incomplete messages are dropped rather than half-applied.
    panel.webview.receive({ type: "comment", file: "a.ts", startLine: 1, endLine: 2 });
    panel.webview.receive({ type: "ask", file: "a.ts", startLine: 1, body: "z" });
    expect(acts.addHumanComment.mock.calls).toEqual([
      ["a.ts", { startLine: 1, endLine: 2 }, "x", false, "new"],
      ["a.ts", { startLine: 3, endLine: 3 }, "y", true, "old"],
    ]);
  });

  it("replies in a thread from reply and askReply", () => {
    const panel = build();
    panel.webview.receive({ type: "reply", threadId: "t1", body: "a" });
    panel.webview.receive({ type: "askReply", threadId: "t1", body: "b" });
    panel.webview.receive({ type: "reply", threadId: "t1" });
    expect(acts.addHumanReply.mock.calls).toEqual([
      ["t1", "a", false],
      ["t1", "b", true],
    ]);
  });

  it("edits a message and resolves a thread", () => {
    const panel = build();
    panel.webview.receive({ type: "editMessage", threadId: "t1", index: 0, body: "new" });
    panel.webview.receive({ type: "editMessage", threadId: "t1", body: "no index" });
    panel.webview.receive({ type: "resolve", threadId: "t1", resolved: true });
    panel.webview.receive({ type: "resolve", threadId: "t2" });
    expect(acts.editMessage.mock.calls).toEqual([["t1", 0, "new"]]);
    expect(acts.resolveThread.mock.calls).toEqual([
      ["t1", true],
      ["t2", false],
    ]);
  });

  it("ignores a message type it does not know", () => {
    const panel = build();
    panel.webview.receive({ type: "nonsense" });
    for (const fn of Object.values(acts)) expect(fn).not.toHaveBeenCalled();
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });
});
