# Idle Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `idle` report how long the review form has gone untouched, so the agent can wait out a careful reader in silence and notice a genuine absence.

**Architecture:** The 60-second poll bound currently does three jobs. Split them: `HttpReviewHost` keeps a per-worktree `lastActivityAt` clock that outlives any single call, the webview pings it on real input, `idle` carries the measured `inactiveForMs`, and the ten-minute policy lives in `SKILL.md` where it can change without a build.

**Tech Stack:** TypeScript, npm workspaces, Zod (protocol), vitest + jsdom (tests), node:http (transport).

**Spec:** `docs/superpowers/specs/2026-07-28-revizorro-idle-semantics-design.md`

## Global Constraints

- TDD: write the failing test, watch it fail, then implement. No exceptions.
- Code, comments, identifiers and commit messages in English.
- No `eslint-disable`, no lowered thresholds, no `v8 ignore`.
- Do not rewrite business-logic tests to fit an implementation. Task 2 changes one existing assertion because the event's contract changed. That is a spec change, and it is called out explicitly where it happens.
- `plugin/skills/revizorro/SKILL.md` may not be edited without listing what, why and how, and receiving explicit confirmation. Task 5 is authored as propose-then-apply.
- The away threshold is ten minutes and lives only in `SKILL.md`. The server measures; it never judges.

---

### Task 1: Protocol carries the measurement

**Files:**
- Modify: `packages/protocol/src/events.ts:46-57`
- Test: `packages/protocol/tests/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `IdleEvent` with optional `inactiveForMs: number`. Tasks 2 and 5 rely on that exact field name.

- [ ] **Step 1: Write the failing test**

```ts
it("accepts an idle event carrying how long the form has gone untouched", () => {
  expect(ReviewEvent.parse({ type: "idle", inactiveForMs: 725_000 })).toMatchObject({
    type: "idle",
    inactiveForMs: 725_000,
  });
});

it("still accepts an idle event without the measurement", () => {
  expect(ReviewEvent.parse({ type: "idle" })).toEqual({ type: "idle" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/protocol/tests/events.test.ts`
Expected: FAIL — Zod strips the unknown key, so `toMatchObject` misses `inactiveForMs`.

- [ ] **Step 3: Add the field**

```ts
export const IdleEvent = z.object({
  type: z.literal("idle"),
  review: z
    .object({
      round: z.number(),
      files: z.number(),
      openThreads: z.number(),
      viewedFiles: z.number(),
    })
    .optional(),
  /**
   * How long the form has gone untouched, in milliseconds. A measurement, not a
   * verdict: what counts as "the human left" is the agent's policy, and lives in
   * the skill. Optional so an older host paired with a newer CLI still parses.
   */
  inactiveForMs: z.number().optional(),
  ...provenance,
});
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/protocol/tests/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/tests/events.test.ts
git commit -m "feat(protocol): idle carries how long the form has gone untouched"
```

---

### Task 2: The host measures inactivity

**Files:**
- Modify: `packages/core-adapters/src/http-server.ts:13` (ceiling), `:19-33` (state), `:60-75` (emit), `:117-142` (request handler and timeout)
- Test: `packages/core-adapters/tests/http.test.ts`

**Interfaces:**
- Consumes: `IdleEvent.inactiveForMs` from Task 1.
- Produces: `HttpReviewHost#noteActivity(worktreeId: string): void`. Task 4 calls it.

- [ ] **Step 1: Write the failing tests**

```ts
it("reports how long the form has gone untouched when a poll times out", async () => {
  host = new HttpReviewHost({ pollTimeoutMs: 120 });
  const port = await host.start();
  const event = await new HttpReviewClient(port).review("wt1", "/repo");
  expect(event).toMatchObject({ type: "idle" });
  expect((event as { inactiveForMs?: number }).inactiveForMs).toBeGreaterThanOrEqual(100);
});

it("restarts the clock when the human touches the form", async () => {
  host = new HttpReviewHost({ pollTimeoutMs: 300 });
  const port = await host.start();
  setTimeout(() => host.noteActivity("wt1"), 200);
  const event = await new HttpReviewClient(port).review("wt1", "/repo");
  expect((event as { inactiveForMs?: number }).inactiveForMs).toBeLessThan(180);
});

it("counts a delivered event as the human being present", async () => {
  host = new HttpReviewHost({ pollTimeoutMs: 300 });
  const port = await host.start();
  const client = new HttpReviewClient(port);
  const first = client.review("wt1", "/repo");
  setTimeout(() => host.emit("wt1", { type: "comment", threadId: "t1", file: "a.ts", side: "new", range: { startLine: 1, endLine: 1 }, body: "x" }), 50);
  await first;
  const event = await client.review("wt1", "/repo");
  expect((event as { inactiveForMs?: number }).inactiveForMs).toBeLessThan(360);
});

it("keeps each worktree's clock to itself", async () => {
  host = new HttpReviewHost({ pollTimeoutMs: 250 });
  const port = await host.start();
  const client = new HttpReviewClient(port);
  const other = client.review("wt2", "/repo2");
  setTimeout(() => host.noteActivity("wt1"), 150);
  const event = await other;
  expect((event as { inactiveForMs?: number }).inactiveForMs).toBeGreaterThanOrEqual(200);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/core-adapters/tests/http.test.ts`
Expected: FAIL — `host.noteActivity is not a function`, and `inactiveForMs` is `undefined`.

- [ ] **Step 3: Raise the ceiling**

```ts
/**
 * How long one call may block before it is answered with `idle`. The agent runs
 * the CLI through a harness whose command timeout caps around ten minutes, so a
 * poll can never wait indefinitely — five minutes sits at half that, which keeps
 * wakeups rare without risking a killed command. How long the HUMAN has been away
 * is a separate quantity, tracked across calls in `lastActivityAt`.
 */
const DEFAULT_POLL_TIMEOUT_MS = 300_000;
```

- [ ] **Step 4: Track activity per worktree**

Add beside `waiters` and `held`:

```ts
  /**
   * When the human last touched this worktree's form. Kept across calls, because
   * inactivity outlives any single poll: a reviewer reading for twenty minutes
   * spans four of them.
   */
  private readonly lastActivityAt = new Map<string, number>();
```

And the method:

```ts
  /**
   * Record that the human is at the form. Reading, expanding context, marking a
   * file viewed and typing all emit no event, so without this a careful reader is
   * indistinguishable from an empty desk.
   */
  noteActivity(worktreeId: string): void {
    this.lastActivityAt.set(worktreeId, Date.now());
  }
```

- [ ] **Step 5: Count a delivered event as activity**

In `emit`, right after the `stamped` const:

```ts
    // Every delivered event began as a human action, so it is proof of presence.
    // The timeout path answers its waiter directly rather than through emit, so
    // `idle` can never reset the clock it is reporting.
    this.noteActivity(worktreeId);
```

- [ ] **Step 6: Seed the clock when the form opens**

In the request handler, before the waiter is registered:

```ts
        // Seeded on the first call for this worktree — the moment the form opens —
        // so inactivity is never measured from the epoch. Only when absent: a
        // re-armed poll is the agent, not the human.
        if (!this.lastActivityAt.has(worktreeId)) this.lastActivityAt.set(worktreeId, Date.now());
```

- [ ] **Step 7: Attach the measurement to the timed-out answer**

Replace the timeout body's `waiter(...)` call:

```ts
        const timer = setTimeout(() => {
          const queue = this.waiters.get(worktreeId);
          const at = queue?.indexOf(waiter) ?? -1;
          if (!queue || at < 0) return;
          queue.splice(at, 1);
          const event = this.idleEvent?.(worktreeId) ?? { type: "idle" as const };
          const since = this.lastActivityAt.get(worktreeId);
          waiter(
            event.type === "idle" && since !== undefined
              ? { ...event, inactiveForMs: Date.now() - since }
              : event,
          );
        }, this.pollTimeoutMs);
```

- [ ] **Step 8: Update the one assertion the contract change invalidates**

`packages/core-adapters/tests/http.test.ts:192` asserts `toEqual({ type: "idle" })`. Idle now also carries `inactiveForMs`, so the exact-match assertion is wrong by design, not by accident:

```ts
    expect(await new HttpReviewClient(port).review("wt1", "/repo")).toMatchObject({ type: "idle" });
```

- [ ] **Step 9: Run the adapter suite and watch it pass**

Run: `npx vitest run packages/core-adapters`
Expected: PASS, including the four new tests.

- [ ] **Step 10: Commit**

```bash
git add packages/core-adapters/src/http-server.ts packages/core-adapters/tests/http.test.ts
git commit -m "feat(adapters): measure form inactivity across polls, widen the poll ceiling"
```

---

### Task 3: The form reports that someone is there

**Files:**
- Create: `packages/extension/media/view/activity.ts`
- Test: `packages/extension/tests/activity.test.ts`

**Interfaces:**
- Consumes: `send` from `packages/extension/media/view/bridge.ts`.
- Produces: `trackActivity(target, now?)`. Task 4 calls it from the webview bootstrap. The message it posts is `{ type: "activity" }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/extension/tests/activity.test.ts`
Expected: FAIL — cannot resolve `../media/view/activity.js`.

- [ ] **Step 3: Write the module**

```ts
import { send } from "./bridge.js";

/**
 * How often a form in active use reports in. Long enough that a busy reviewer
 * costs two messages a minute at worst, short enough that a minutes-scale
 * absence threshold can never be crossed by a reader who is simply quiet.
 */
const THROTTLE_MS = 30_000;

/**
 * Tell the host a human is at the form. Bound to real input rather than a timer:
 * a timer would keep reporting activity from a tab left open on an empty desk,
 * which is precisely the lie this exists to remove.
 */
export function trackActivity(target: EventTarget, now: () => number = () => Date.now()): void {
  let lastSent = Number.NEGATIVE_INFINITY;
  const ping = (): void => {
    const t = now();
    if (t - lastSent < THROTTLE_MS) return;
    lastSent = t;
    send({ type: "activity" });
  };
  target.addEventListener("pointerdown", ping);
  target.addEventListener("keydown", ping);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/extension/tests/activity.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/media/view/activity.ts packages/extension/tests/activity.test.ts
git commit -m "feat(extension): report human presence from the review form"
```

---

### Task 4: Wire the ping to the clock

**Files:**
- Modify: `packages/extension/media/webview.ts:32` (after `setBridge`)
- Modify: `packages/extension/src/host.ts` (add `noteActivity`)
- Modify: `packages/extension/src/form.ts:99-118` (message routing)

**Interfaces:**
- Consumes: `trackActivity` (Task 3), `HttpReviewHost#noteActivity` (Task 2).
- Produces: nothing further tasks depend on.

Automated coverage stops at the module boundary here, and that is a deliberate limit rather than an oversight. `form.ts` imports `vscode`, and this repo has no VS Code test harness; `@vscode/test-electron` is not a dependency, and adding one is its own epic. Both pieces that hold logic are already covered: the throttle in Task 3, the clock in Task 2. What remains is three wiring lines, verified by the compiler and by a manual run. File a follow-up bead for the harness rather than pretending the wiring is tested.

- [ ] **Step 1: Call the tracker from the webview bootstrap**

In `packages/extension/media/webview.ts`, alongside the existing `setBridge` call:

```ts
import { trackActivity } from "./view/activity.js";
```

and after `setBridge(...)`:

```ts
// Any input anywhere in the form counts, so listen at the document.
trackActivity(document);
```

- [ ] **Step 2: Add the forwarding method to the host**

In `packages/extension/src/host.ts`, next to `isAgentWaiting`:

```ts
  /**
   * The form saw human input. Forwarded to the broker so a long, quiet read does
   * not read as an abandoned review. No open round means nothing to keep alive.
   */
  noteActivity(): void {
    if (this.current) this.events.noteActivity(this.current.worktreeId);
  }
```

- [ ] **Step 3: Route the message**

In `packages/extension/src/form.ts`, inside `onDidReceiveMessage`, add a branch beside `ready`:

```ts
        } else if (m.type === "activity") {
          this.host.noteActivity();
```

- [ ] **Step 4: Build and type-check**

Run: `npm run build && npx tsc -p packages/extension/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, no regressions against the 229 existing tests plus the ones added here.

- [ ] **Step 6: Verify by hand in the Extension Development Host**

Bump the extension version (VS Code caches same-version installs), press F5, run `revizorro review` against a repo with a diff, then leave the form alone and watch the CLI. The first `idle` should arrive after five minutes rather than one, and `inactiveForMs` should be close to the time you actually spent away. Scroll and type in the form, and the next `idle` should report a small value.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/media/webview.ts packages/extension/src/host.ts packages/extension/src/form.ts
git commit -m "feat(extension): forward form input to the inactivity clock"
```

---

### Task 5: Teach the agent the new meaning

**Files:**
- Modify: `plugin/skills/revizorro/SKILL.md:85-105` (idle section), plus a new rule on merges

This task is propose-then-apply. `SKILL.md` may not be edited without an explicit go-ahead.

- [ ] **Step 1: Put the proposal to the user**

State plainly what changes, why, and how:

- **What.** Rewrite the `idle` bullet: it now means the form has gone untouched for `inactiveForMs`, not that a minute elapsed. Add the ten-minute minimum, the report-once rule, and a new top-level rule that merges do not start a review loop.
- **Why.** The event now carries a measurement, so the old heuristic — "about a minute … ten in a row is a human reading" — is guesswork the agent no longer needs. And a merge commit is not authored work; the review already happened before it.
- **How.** Three edits, no restructuring of the surrounding sections.

- [ ] **Step 2: On approval, rewrite the idle bullet**

```markdown
   - **`idle`** — the poll hit its ceiling. This is the normal heartbeat of a
     review, not a fault. Re-arm:

     ```bash
     revizorro review
     ```

     Re-arm with NO scope flags: a bare call keeps reviewing whatever the round is
     already showing, while `--worktree` would widen a staged-only review to the
     whole branch.

     `idle` carries `inactiveForMs` — how long the form has gone untouched. Wait a
     MINIMUM of ten minutes of that before reading anything into silence:

     - Under ten minutes: re-arm silently. Say nothing to the user, do not check
       whether the form opened, do not inspect the host registry, do not restart
       anything. A careful reader is quiet for long stretches; that is what
       reviewing looks like.
     - Ten minutes or more: tell the user ONCE, in their language, that the form
       has not been touched for that long — then keep re-arming silently. Repeat
       it only if activity resumes and then stops again. Never end the loop:
       Approve still unblocks you the moment the human comes back, and an
       abandoned loop would leave them approving into a form nobody is listening
       to.

     `idle` also carries a `review` snapshot — `round`, `files`, `openThreads`,
     `viewedFiles` — which is proof the round is live. If that snapshot is missing
     across several `idle` events in a row, THEN something is off and it is worth
     telling the user.
```

- [ ] **Step 3: Add the merge rule**

Beside the other loop-entry rules:

```markdown
- **Merges do not start a review loop.** A merge commit carries no authored work
  — the review happened on the branch before it. Do not run `revizorro review`
  for a merge, and do not treat a merge as an unreviewed change.
```

- [ ] **Step 4: Bump the plugin version**

Patch bump in the plugin manifest, per the versioning rule.

- [ ] **Step 5: Commit**

```bash
git add plugin/skills/revizorro/SKILL.md plugin/.claude-plugin/plugin.json
git commit -m "docs(skill): idle is measured absence, and merges skip the loop"
```

---

## Self-review

**Spec coverage.** Poll ceiling — Task 2 Step 3. `lastActivityAt` with seeding and the no-reset-on-re-arm rule — Task 2 Steps 4, 6. `noteActivity` — Task 2 Step 4. `emit` counting as activity — Task 2 Step 5. `inactiveForMs` on the protocol — Task 1. Throttled input ping — Task 3. Wiring — Task 4. Skill policy, ten-minute minimum, merge rule — Task 5. Every edge case in the spec has a test in Task 2 or 3 except "webview reload", which resumes on the first interaction by construction and has nothing to assert.

**Placeholders.** None: every code step carries the actual code, and Task 4's coverage limit is stated with its reason rather than waved at.

**Type consistency.** `inactiveForMs` is spelled identically in Tasks 1, 2 and 5. `noteActivity` takes `worktreeId: string` on the broker (Task 2) and no argument on `ReviewHost` (Task 4), which reads the id off the open round. The difference is deliberate, and both signatures appear in full.
