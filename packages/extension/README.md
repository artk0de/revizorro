<p align="center">
  <img src="https://raw.githubusercontent.com/artk0de/revizorro/main/assets/logo.png" alt="Revizorro" width="220" />
</p>

<h1 align="center">Revizorro</h1>

<p align="center">
  Review what the AI agent wrote — <b>before</b> it is committed, in a real
  GitHub-PR-grade form, without leaving VS Code.
</p>

---

Agents write a lot of code, fast. The usual choices are to skim a wall of diff in
the chat window, or to push a branch and open a PR just to get a comment box.
Revizorro gives you the third one: the agent stops, opens a proper review form
over your **worktree diff**, and waits for your verdict. Nothing is pushed,
nothing leaves your machine.

<p align="center">
  <img src="https://raw.githubusercontent.com/artk0de/revizorro/main/assets/screenshots/01-review.png" alt="Inline review — syntax-highlighted diff, threaded comments, approve / request changes" width="90%" />
</p>

## How it works

Two processes talk over localhost. The agent runs a blocking command; you review
in the editor; your action is what unblocks it.

```
Claude Code (agent)              VS Code (this extension)
  revizorro review ───HTTP──▶    the review form opens
     [blocks, waiting]           you read the diff, leave comments
        ◀────────────────────    Approve / Request changes / Ask agent
  agent fixes, pushes replies ▶  replies land in the open threads
     ...loop until you approve
```

The agent never merges on its own. **Approve is the gate** — it is the only thing
that ends the loop.

## What you get

- **Review before the commit.** The diff under review is your working tree, not a
  pushed branch. No PR, no remote round-trip, no waiting on CI to see the code.
- **A conversation, not a report.** Leave line-anchored comments, hit **Ask
  agent** and get an answer while the form stays open. Request changes and the
  agent fixes them, then writes back what it did — you re-review in place.
- **A diff you can actually read.** Syntax highlighting in your own VS Code
  theme, split and inline modes, multi-line comment selection, expandable
  context, a file tree with unresolved-thread counts, and viewed-collapse that
  un-marks itself when the agent touches that file again.
- **Scoped how you work.** Review only what is staged (the pre-commit gate) or
  the whole branch against any target branch you pick.
- **Local and private.** A localhost HTTP server and your git worktree. No
  third-party review service, no telemetry, nothing uploaded.

## Getting started

Three pieces: this extension, the CLI the agent calls, and the Claude Code skill
that teaches the agent the loop.

**1. This extension** — install it from the Marketplace.

**2. The CLI**, on your PATH:

```bash
npm i -g @revizorro/cli
```

**3. The Claude Code plugin** (the `/revizorro` skill):

```text
/plugin marketplace add artk0de/revizorro
/plugin install revizorro@revizorro
```

Then open the project in VS Code and, in Claude Code, run:

```text
/revizorro
```

The agent opens the form, you review, it iterates until you approve.

## Requirements

- VS Code 1.90 or newer
- A git repository (the review is a diff of your worktree)
- An agent that can run a shell command — Claude Code today; the protocol is a
  plain blocking CLI, so other harnesses can drive it too

## How the extension is found

On activation it starts a localhost HTTP server and writes the port to
`<repoRoot>/.claude/revizorro/port`, plus a host record under
`~/.claude/revizorro/hosts/`. The CLI reads those to reach the right window — so
with several VS Code windows open, the review lands in the one that owns the
project being reviewed.

## Commands

| Command | What it does |
| --- | --- |
| `Revizorro: Toggle Diff View (split/inline)` | Switch the diff rendering mode |
| `Revizorro: Approve` | End the round — the agent is unblocked to proceed |
| `Revizorro: Request changes` | Send the open threads back for fixes |
| `Revizorro: Clarify` | Ask the agent a question without ending the round |

## Links

- [Source, issues and full documentation](https://github.com/artk0de/revizorro)
- [Report a bug](https://github.com/artk0de/revizorro/issues)

Licensed MIT.
