# revizorro — Design Spec

**Date:** 2026-06-29
**Status:** Approved (brainstorming) — pending user spec review → writing-plans
**Repo:** standalone `revizorro` monorepo (sibling to `tea-rags-mcp`)

## 1. Goal

A local, GitHub-PR-grade code review loop for the **worktree diff before merge**,
without GitHub. The agent generates code; the human reviews it inline in VS Code
(line-anchored comments, approve/decline, viewed-collapse); the agent applies
fixes and re-submits. Realtime mid-review dialogue between human and agent is a
first-class feature.

Non-goal: replacing GitHub PR review for team workflows. revizorro is a
single-developer, single-worktree, pre-merge gate driven by an AI agent.

## 2. Load-bearing protocol — re-entrant single command + persistent form

Two requirements — **realtime agent replies** and **viewed-state across review
rounds** — rule out a naive "one blocking call returns one result" model. They
force:

- **The review session is a stateful, long-lived object hosted in the VS Code
  extension.** It holds comment threads, per-file `{viewed, contentHash}`,
  approve/decline status, and the current round number. The form (UI) stays open
  across many ephemeral CLI invocations; it closes only on a final approve, or
  re-renders for the next round on decline.
- **The CLI is a stateless RPC client.** Each invocation = one event delivered,
  then process exit.
- **The agent runs an event loop**, not a single blocking call.

The signal "your turn, agent" is **the CLI output ending** (process exit), NOT
the form closing.

### 2.1 Single re-entrant command

```
# Start a round (or attach to the worktree's open session)
revizorro review --worktree
  → detect branch/worktree from cwd, compute diff vs merge-base, open the form,
    BLOCK until the form yields exactly ONE event, print it as JSON, EXIT:
       { type: "question",  threadId, file, range, body }   # form stays open
       { type: "comment",   threadId, file, range, body }   # human comment to address
       { type: "decision",  verdict: "approved" }           # form closes, round OK
       { type: "decision",  verdict: "declined", comments[] }# round ends, agent must fix
       { type: "idle" }                                      # no event before ~9min cap; agent re-calls

# Agent acted on the event → re-enter the SAME open form, carrying its output
revizorro review --push payload.json
  → payload = { replies: [{threadId, body}], comments: [{file, range, body}] }
  → push agent replies/comments into the open form, BLOCK for the next event,
    print + EXIT
```

The CLI auto-resolves the session by worktree (cwd) — no explicit `sessionId`
arg. `--push` carries the agent's output; absence of `--push` on the first call
of a round starts a fresh round.

### 2.2 Agent loop

```
revizorro review --worktree
loop:
  case question:  compute reply → revizorro review --push {replies}   # same open form
  case comment:   fix/answer    → revizorro review --push {...}        # same open form
  case idle:      revizorro review --worktree                          # re-arm under Bash cap
  case approved:  exit loop → merge / proceed
  case declined:  apply fixes to code → revizorro review --worktree    # round N+1 (unchanged+viewed files collapsed)
```

Both UX cases the user described reduce to "output ends = agent's turn"; the only
difference is the event type. `question` keeps the form open (realtime dialogue
inside a round); `decision` is a round boundary.

### 2.3 Why this beats the 10-minute foreground Bash cap

Each CLI call returns on the first event, so the only risk is human silence
> ~9 min. The CLI emits `{type:"idle"}` before the harness's 600 000 ms cap and
the agent re-calls. Total review time is unbounded; each individual call stays
under the cap. (Background execution + harness resume is the alternative; the
idle-poll keeps the agent attached to a single conversational thread, which is
simpler.)

## 3. Components

| Component | Responsibility |
| --- | --- |
| **CLI** (`revizorro`) | Stateless RPC client: `review` (start round / long-poll one event), `--push` (deliver agent output). Detects branch/worktree. Prints event JSON to stdout. |
| **VS Code extension** | Session host: native diff editor (side-by-side + inline), Comments API (line-anchored multi-author threads), webview/TreeView review shell (file list, viewed-collapse, approve/decline, round indicator). Hosts the localhost HTTP server. |
| **Host / event broker** | Localhost HTTP server inside the extension. Holds the live session; serves `review`/`push` as long-poll RPC. |
| **Session store** | JSON under `.claude/revizorro/<worktree-id>/` — round number, per-file `{viewed, contentHash}`, thread state. Survives window reload + feeds cross-round collapse. |
| **Diff engine** | Computes worktree diff vs branch merge-base (includes uncommitted changes). |
| **`/revizorro` skill** | Claude Code plugin skill orchestrating the agent event loop. |

## 4. Architecture — hexagonal (tea-rags patterns, simplified)

Mirror tea-rags' ports/adapters layering, scaled down (no codegraph/embedding
complexity):

```
revizorro/
  protocol/        # shared Zod schemas: events, payloads, session state (DIP boundary)
  core/            # domain: review session, round lifecycle, viewed/collapse logic, event reduction — PURE, no I/O
    ports/         #   ReviewTransport, SessionStore, DiffProvider, FormPort interfaces
  adapters/
    http/          #   localhost HTTP transport (server side in extension, client side in CLI)
    store-fs/      #   JSON file SessionStore
    diff-git/      #   git-based DiffProvider
  cli/             # CLI surface (api/public equivalent) — thin command layer over core via ports
  extension/       # VS Code extension — FormPort adapter (diff editor + Comments API + webview shell) + HTTP host
  plugin/          # /revizorro SKILL.md + slash command
  bootstrap/       # wiring per process (CLI process vs extension process)
```

Reused tea-rags conventions: **Zod schemas** as the protocol/DIP boundary;
**Factory.create** for construction; ports/adapters separation; per-process
`bootstrap` wiring. Simplifications: no daemon (JSON file store instead of
DuckDB), no multi-language domains, single transport.

## 5. Session state model

Per worktree, persisted to `.claude/revizorro/<worktree-id>/session.json`:

```
{
  round: N,
  files: { "<path>": { viewed: bool, contentHash: "<sha>" } },
  threads: [ { id, file, range, author: "human"|"agent", body, resolved } ],
  status: "open" | "approved" | "declined"
}
```

**Cross-round collapse:** on round N+1, recompute diff. For each file:
`viewed && contentHash unchanged → render collapsed`; otherwise expand and clear
`viewed`. State keyed by worktree path so it survives window reload.

## 6. Diff view modes

Both delivered by VS Code's **native diff editor** — no custom rendering:

- **side-by-side / split** (old | new) — "vertical"
- **inline / unified** (+/- stacked) — "horizontal"

Toggle lives in the webview review shell. (Term mapping to confirm with user;
does not affect architecture.)

## 7. Distribution

CLI and extension are separate processes (CLI = HTTP client to the extension's
localhost server), so distribute via native channels:

| Artifact | Channel | PATH |
| --- | --- | --- |
| **CLI** (`revizorro`) | `npm i -g revizorro` | on PATH free via npm global bin |
| **Extension** | VS Code Marketplace / `.vsix` | installed into VS Code |
| **Discovery** | extension writes its port to `.claude/revizorro/port`; CLI reads it | — |

**Why not bundle the binary in the `.vsix`:** a `.vsix` *can* carry an
executable (many extensions bundle language servers), but a binary inside the
extension folder is NOT on the agent's PATH — the agent is a separate shell
process. VS Code cannot silently modify PATH. Bridging requires a `code`-style
"Install 'revizorro' in PATH" command that writes a consented shim. That buys
"one fewer install" at the cost of OS-specific shim handling + PATH write
permissions.

**Decision:** npm-global CLI + marketplace extension for MVP (zero PATH hackery,
independent versioning, matches the tea-rags muscle memory). Bundled-binary +
PATH-shim deferred to **v2 convenience**. The `/revizorro` plugin documents both
installs (and may offer an opt-in `npm i -g` on first run — no auto-magic).

## 8. Lenses — TBD

Direct the agent's attention to a review dimension (security / performance /
naming / architecture / tests / correctness). Design intent (not committed):

- **CLI-side composable profiles**, NOT a proliferation of slash-commands:
  `revizorro review --lens security,correctness`.
- Single source of truth in the CLI; lens guidance flows to the agent in each
  event payload.
- A lens carries more than a prompt: a focus checklist + an optional **tea-rags
  rerank preset** (`securityAudit` / `hotspots` / `techDebt` / `codeReview`) +
  `pathPattern` scope + severity. The preset pre-highlights risky chunks in the
  diff before the agent's pass. This is the one real coupling to tea-rags, and
  it is the reason "reuse tea-rags infra similarly" matters here.
- Enables an optional **agent lens-focused review pass** (agent reviews its own
  diff through the lens, posts findings as threads) before the human reviews.

Deferred — not on the MVP critical path. Sketched here so the protocol leaves
room (`lens` field on the round-start payload).

## 9. Error handling

- **Idle / human silence** → `{type:"idle"}` before the Bash cap; agent re-calls.
- **Extension not running / no port file** → CLI exits non-zero with a clear
  message; the skill instructs the user to open VS Code / install the extension.
- **Stale port** (extension restarted) → CLI re-reads the port file; on connect
  failure, surfaces "extension unreachable" rather than hanging.
- **Decline loop** → bounded by the human (each round needs an explicit verdict);
  no infinite auto-loop — the agent only re-submits after applying fixes.
- **Worktree changed under the form** (files edited mid-review) → content-hash
  mismatch on next round expands the affected files and clears `viewed`.

## 10. Testing

- **core/** — pure domain logic (round reduction, viewed/collapse decisions,
  event handling) unit-tested with no I/O. Highest coverage target.
- **protocol/** — Zod schema round-trip + validation tests.
- **adapters/** — `store-fs` (round-trip persistence), `diff-git` (against
  fixture repos), `http` (client/server contract).
- **cli/** — command-surface tests over mocked ports.
- **extension/** — integration via VS Code extension test harness for the
  Comments API + webview shell (lighter; UI-heavy paths validated manually).
- TDD per the project rule: failing test first, then implementation.

## 11. Increments

- **I1 — Core loop (MVP):** re-entrant `review`/`--push` protocol, inline diff,
  line-anchored comments, approve/decline, viewed-collapse, JSON session store,
  `/revizorro` skill, npm-global + marketplace distribution.
- **I2 — Lens system:** CLI-side composable lenses + tea-rags rerank-preset
  pre-highlighting + optional agent lens-pass.
- **I3 — Side-by-side diff + realtime polish:** split view, richer agent-reply
  rendering, idle/reconnect hardening, v2 bundled-shim distribution.

## 12. Open questions / TBD

- Diff-mode term mapping (vertical/horizontal → split/inline) — confirm with user.
- Lens taxonomy + exact tea-rags coupling surface (I2).
- Whether the agent lens-pass is opt-in per round or implied by `--lens`.
- Multi-window support (would force a daemon over extension-as-host) — out of
  scope unless requested.
