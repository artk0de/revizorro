# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
npm run build      # every package, in dependency order
npx vitest run     # whole suite
npx eslint .       # zero errors is the gate; warnings are tracked, not ignored
```

## Ship the build after every change (MANDATORY)

Touched anything under `packages/` and finished the change? **Install the fresh
build without being asked.** Reviewing against a stale extension wastes the
human's time on bugs that are already fixed, or hides ones that are not.

```bash
# 1. Bump the extension version. NOT optional — VS Code serves a cached copy
#    when --force reinstalls a version it already has, so a same-version install
#    silently leaves the old code running.
#    packages/extension/package.json: "version": "0.0.N" -> "0.0.N+1"

npm run build
cd packages/extension && npx --yes @vscode/vsce package --no-dependencies -o /tmp/revizorro.vsix
code --install-extension /tmp/revizorro.vsix --force

# 2. Verify by reading back what is actually installed, never by assuming:
code --list-extensions --show-versions | grep revizorro
```

Then **tell the human to reload the VS Code window**. `--install-extension`
writes to disk, but a running window keeps executing the extension host it
started with, so the new code is not live until a reload. Reloading mid-review
also drops the open round's long poll.

The CLI needs no separate step: `@revizorro/cli` is `npm link`ed to this
checkout, so `npm run build` alone refreshes the `revizorro` binary.

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
