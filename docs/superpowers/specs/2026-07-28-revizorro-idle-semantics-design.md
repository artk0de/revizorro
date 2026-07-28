# Idle means "the form is untouched", not "a minute passed"

Date: 2026-07-28
Status: approved, ready for implementation

## Problem

A long poll is bounded at 60 seconds (`DEFAULT_POLL_TIMEOUT_MS`,
`packages/core-adapters/src/http-server.ts:13`). When the bound is hit the waiter
is pulled from the queue and answered with `idle`
(`http-server.ts:136-142`), so the agent's command returns and the loop re-arms.

That makes `idle` mean exactly one thing: *sixty seconds elapsed*. It says
nothing about the human. And most of what a reviewer actually does — reading the
diff, expanding context, marking files viewed, resolving threads, typing a
comment that is not sent yet — emits no event at all. So a reviewer who is
twenty minutes deep in a careful read is indistinguishable, from the agent's
side, from a reviewer who closed the laptop and went to lunch.

Three consequences, all observed:

- The agent wakes every 60 seconds and burns a tool call on a non-event.
- Repeated `idle` reads as a fault, so the agent starts diagnosing a healthy
  form — checking whether it opened, inspecting the host registry, restarting
  things.
- The genuine "nobody is there" case has no signal of its own, so it cannot be
  handled at all.

## Design

The 60-second constant is doing three unrelated jobs at once. Split them, and
each lands in the layer that owns it.

| Quantity | Owner | Why there |
| --- | --- | --- |
| Poll ceiling — how long one HTTP call may block | `HttpReviewHost` | Transport concern, bounded by the agent harness |
| Inactivity — how long the human has not touched the form | `HttpReviewHost` | Spans calls, so it must outlive any single poll |
| Away threshold — when absence is worth reporting | `SKILL.md` | Policy, changeable without shipping a build |

### Poll ceiling

`DEFAULT_POLL_TIMEOUT_MS` goes from 60_000 to 300_000. The agent runs the CLI
through a harness whose command timeout caps around ten minutes, so a call can
never block indefinitely; five minutes sits at half that ceiling, leaving room
for a slow start without risking a kill. Wakeups drop fivefold.
`REVIZORRO_POLL_TIMEOUT_MS` keeps overriding it, and tests keep setting it low.

### Inactivity tracking

`HttpReviewHost` gains `lastActivityAt: Map<string, number>`, keyed by
`worktreeId` exactly like `waiters` and `held`.

Seeded when a worktree first issues a review request — the moment the form
opens — so the clock never counts from the epoch. Only seeded when absent: a
re-armed poll is the agent, not the human, and must not reset it.

Updated from two sources:

- `emit()` — every delivered event (comment, question, decision, closed)
  originates in a human action and is proof of presence on its own. Note that
  the timeout path calls the waiter directly (`http-server.ts:141`) rather than
  going through `emit()`, so `idle` cannot reset its own clock.
- `noteActivity(worktreeId)` — a new public method for interactions that produce
  no event.

The webview drives `noteActivity` through the extension host. The ping is bound
to real input — `pointerdown` and `keydown` — and throttled to once per 30
seconds. Input, not a timer: a timer would keep reporting activity from a tab
left open on an unattended machine, which is the exact lie this design exists to
remove.

### Protocol

`idle` gains one optional field:

```ts
{ type: "idle", at, review?, inactiveForMs?: number }
```

`inactiveForMs` is `now - lastActivityAt` — a measurement, carrying no judgement
about whether that counts as "away". Optional in the Zod schema so an older CLI
paired with a newer host keeps parsing.

### Agent policy

Lives in `plugin/skills/revizorro/SKILL.md`. The agent waits a minimum of ten
minutes before treating silence as absence:

- `inactiveForMs` under 10 minutes — re-arm silently. No report, no
  investigation, no restart. This is the normal texture of a review.
- `inactiveForMs` at or over 10 minutes — report once, in the user's language,
  that the form has not been touched for that long. Then keep re-arming
  silently. Repeat the report only if activity resumes and then stops again.
- Approve still unblocks the agent at any point. The loop is never abandoned on
  absence, because ending it would leave a returning reviewer approving into a
  form nobody is listening to.

Two further skill edits ride along:

- Merges do not start a loop. A merge commit is not authored work; the review
  happened before it. The agent must not open a review round for a merge.
- The idle section is rewritten around the new meaning, replacing the current
  "about a minute … ten in a row is a human reading" heuristic, which the
  measurement now makes unnecessary.

## Data flow

```
webview (pointerdown / keydown, throttled 30s)
   └─▶ extension host ──▶ HttpReviewHost.noteActivity(worktreeId)
                              └─▶ lastActivityAt[worktreeId] = now

poll blocks ── 5 min ceiling ──▶ idle { review, inactiveForMs: now - lastActivityAt }
   └─▶ agent: under 10 min → silent re-arm
              at/over 10 min → report once, then silent re-arm
```

## Edge cases

- **Several worktrees.** Activity in one must not reset another's clock; the map
  is per-`worktreeId`, same as the existing queues.
- **Webview reload.** Pings resume on the first interaction after reload; the
  seeded value keeps the interval finite in the meantime.
- **Form open, never touched.** Clock runs from form open, so a reviewer who
  never engages is correctly reported as absent after ten minutes.
- **Old CLI, new host.** `inactiveForMs` is optional; a missing field means the
  agent falls back to treating `idle` as a bare heartbeat.

## Testing

Failing tests first, per TDD.

- `packages/core-adapters/tests/http.test.ts` — a poll answers `idle` at the
  ceiling; `noteActivity` resets the clock so a later `idle` reports a small
  `inactiveForMs`; a delivered event also counts as activity; activity in one
  worktree leaves another's `inactiveForMs` untouched; a re-armed poll does not
  reset the clock.
- `packages/protocol/tests/events.test.ts` — `idle` parses with and without
  `inactiveForMs`.
- `packages/extension/tests/` — interaction posts a throttled ping and a quiet
  form posts none (jsdom); the ping reaches `noteActivity` on the host.

## Non-goals

- Blocking a single call for the full ten minutes. That would sit exactly at the
  harness ceiling and break on any change to it.
- Ending the review loop on absence.
- Any new UI in the form. Absence is reported to the agent's console, not
  rendered.

## Files affected

| File | Change |
| --- | --- |
| `packages/core-adapters/src/http-server.ts` | ceiling 60s → 5min; `lastActivityAt` map; `noteActivity`; `inactiveForMs` on the timeout answer |
| `packages/protocol/src/events.ts` | optional `inactiveForMs` on `idle` |
| `packages/extension/src/host.ts` | route the webview ping to `noteActivity` |
| `packages/extension/media/view/activity.ts` | new module: registers the throttled input listeners, posts through `bridge.send`; wired from the webview bootstrap |
| `plugin/skills/revizorro/SKILL.md` | idle policy, 10-minute minimum, merges do not start a loop |
