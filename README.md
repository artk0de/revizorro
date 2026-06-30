<p align="center">
  <img src="assets/logo.png" alt="revizorro" width="300" />
</p>

# revizorro

Local, GitHub-PR-grade code review of the **worktree diff before merge** — driven
by an AI agent, reviewed by you inline in VS Code. No GitHub required.

The agent generates code, opens a review form in VS Code where you leave
line-anchored comments and approve/decline; the agent applies fixes and
re-submits until you approve. Realtime mid-review dialogue with the agent is
first-class.

## Key features

- **Stay in flow — no PR/MR.** Review the worktree diff locally, *before* you
  merge. No pushing to GitHub / GitLab / Bitbucket, no pull-request round-trip —
  the whole gate happens on your machine, in your editor.
- **A continuous loop with the agent.** Not a one-shot report: leave inline
  comments, **Ask agent** for an immediate answer, and on decline the agent fixes
  everything and writes back what it did — you resolve and re-review without ever
  leaving VS Code.
- **Harness-agnostic by design.** The loop is driven through a plain blocking CLI
  and a localhost protocol, so any agent runtime that can run a command can drive
  it — Claude Code today; Codex / Cursor / Windsurf next.
- **GitHub-PR-grade UX, locally.** Syntax-highlighted diff (in your VS Code
  theme), split / inline modes, line-anchored threads, multi-line comments,
  viewed-collapse, resolve, and Cmd/Ctrl+Enter hotkeys.
- **Review is the gate.** Approve actually unblocks the merge; the agent never
  merges on decline — it fixes and comes back.
- **Local & private.** Nothing leaves your machine — no third-party review
  service, no telemetry.

## Screenshots

<p align="center">
  <a href="assets/screenshots/01-review.png">
    <img src="assets/screenshots/01-review.png" width="32%" alt="Inline review — syntax-highlighted diff, GitLab-style threads, 3-action toolbar" />
  </a>
  <!-- More thumbnails go here (same width so they wrap into a row). -->
</p>

## Architecture

Two processes, one localhost channel:

```
/revizorro (agent)            VS Code extension (form host)
   │  revizorro review ──HTTP──▶  long-poll: 1 event per call
   │     [blocks]                 you review inline (Comments API)
   │  ◀─── { question | comment | decision } ── output ends = agent's turn
   │  revizorro review --push ─▶  agent reply/fix into the open form
   │     ...loop until approved
```

- **CLI** (`@revizorro/cli`) — stateless HTTP client. Each `revizorro review`
  blocks until one review event, prints it as JSON, exits.
- **Extension** (`revizorro`) — hosts the long-lived review session + a localhost
  HTTP server; renders the diff (native editor, split/inline) + line-anchored
  threads (Comments API) + a file list with viewed-collapse and approve/decline.
- **Discovery** — the extension writes its port to
  `<repoRoot>/.claude/revizorro/port`; the CLI reads it.

## Install

Three pieces — the Claude Code plugin (skill), the CLI, and the VS Code extension.

**1. Claude Code plugin** (the `/revizorro` skill). Installed from this repo's
marketplace — auto-updates when the marketplace is refreshed:

```text
/plugin marketplace add artk0de/revizorro
/plugin install revizorro@revizorro
```

**2. CLI** — on PATH via npm global bin:

```bash
npm i -g @revizorro/cli
```

**3. VS Code extension** — from the Marketplace (or a local `.vsix`):

```bash
code --install-extension revizorro.vsix
```

Then, in a project open in VS Code with the extension active:

```text
/revizorro     # in Claude Code — drives the review loop
```

## Develop

npm workspaces — same toolchain as a single-package repo:

```bash
npm install
npm run build   # tsc + esbuild bundles (cli → dist/revizorro.cjs, extension → dist/extension.cjs)
npm test        # vitest across protocol / core / adapters / cli

# put `revizorro` on PATH (like tea-rags):
cd packages/cli && npm link
```

Extension runtime: open `packages/extension` and press F5 for the Extension
Development Host.

## Status

I1 (MVP core loop) — protocol, domain, adapters, CLI: implemented and tested.
Extension form: implemented; runtime pending manual F5 validation.
Lenses (I2) and side-by-side diff polish (I3) are future increments. See
`docs/superpowers/specs/2026-06-29-revizorro-design.md`.
