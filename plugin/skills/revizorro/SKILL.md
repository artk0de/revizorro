---
name: revizorro
description: Run a local pre-merge code review of the current worktree diff in VS Code. The agent opens the review form, then drives a blocking event loop — answering questions, addressing comments, and re-submitting after fixes — until the human approves or the loop is cancelled. Triggers on "review my changes", "revizorro", "review the worktree before merge", "отревьюь ворктри".
---

# revizorro — agent review loop

You drive a human review of the current worktree diff. The VS Code extension
hosts a long-lived review form; the `revizorro` CLI is your blocking interface to
it. Each `revizorro review` call **blocks until exactly one review event**, prints
it as JSON, and exits. The form stays open across calls — the output ending is
your turn to act, not the form closing.

## Prerequisites

- At least ONE VS Code window with the revizorro extension is open. It does NOT
  have to be this project's window — every window registers itself, and the CLI
  picks one, preferring a window that has THIS project open, else any other.
- `revizorro` is on PATH (`npm i -g @revizorro/cli`).

You may run from any terminal — the review window is separate. The CLI finds a
host via the global registry (`~/.claude/revizorro/hosts/`) and sends this
project's path, so the chosen window reviews THIS worktree regardless of which
folder it has open. The form appears in that window.

If `revizorro review` exits with `no revizorro window found …`, ask the user to
open a folder in VS Code with the extension active, then retry. Dead/closed
windows are skipped and cleaned up automatically.

## The loop

1. Start a round:

   ```bash
   revizorro review --worktree
   ```

   It blocks. When it returns, parse the single JSON event from stdout.

   **Reviewing before a commit — the default.** When the work is ready to commit,
   stage exactly what belongs in that commit and review the staged change first:

   ```bash
   git add <the files for this commit>
   revizorro review --staged-only
   ```

   `--staged-only` baselines against HEAD, so the human sees only what is about to
   be committed — not the commits already on the branch. Commit only after the
   review comes back `approved`. Keep the flag on every call of that round
   (`--push` included) so the diff does not flip mid-review.

   **Reviewing a whole branch.** Without `--staged-only` the review covers the
   branch against its target: every commit since the fork point plus the dirty
   worktree. Use this for a deep review of the finished branch.

   **Choosing the target.** The target branch is auto-detected (`origin/HEAD`,
   else `main`/`master`). When the branch targets something else — a release
   branch, a stacked branch — say so explicitly, or the review will show unrelated
   work:

   ```bash
   revizorro review --worktree --base develop
   ```

2. Branch on `event.type`:

   - **`question`** `{ threadId, file, side, range, body }` — the human asked you
     something about a specific line range (`side` is `"old"` for a deleted line,
     `"new"` for added/context). Compose an answer, write it to a push file, and
     re-enter the form (the form stays open):

     ```bash
     # write {"replies":[{"threadId":"<id>","body":"<your answer>"}],"comments":[]}
     # to $CLAUDE_JOB_DIR/tmp/revizorro-push.json (or a temp file)
     revizorro review --push "$CLAUDE_JOB_DIR/tmp/revizorro-push.json"
     ```

     Then loop back to step 2 with the next event.

   - **`comment`** `{ threadId, file, side, range, body }` — a passive comment. Note it,
     but do NOT edit code yet. You may reply via `--push` if a clarification
     helps. Fixes are applied later, on `changes_requested`. Loop back to step 2.

   - **`idle`** — no human action before the poll cutoff. Just re-arm:

     ```bash
     revizorro review --worktree
     ```

     Loop back to step 2. (This keeps each call under the host timeout; total
     review time is unbounded.)

   - **`decision` / `approved`** — the human approved. Stop the loop. Proceed to
     merge (or report ready-to-merge).

   - **`decision` / `changes_requested`** `{ comments: [...] }` — NOW apply fixes
     for every comment. For each addressed comment, `--push` a reply into its
     thread saying what you did (so the human can verify and mark it resolved).
     Then start a NEW round:

     ```bash
     revizorro review --worktree
     ```

     Unchanged files the human already marked viewed will be collapsed. Loop back
     to step 2.

   - **`decision` / `clarify`** `{ comments: [...] }` — the human wants answers,
     NOT code changes. Answer EVERY comment in the list: `--push` a reply into
     each thread. Do not edit code. The form stays open and shows a loader per
     unanswered thread (and a top-bar total) that clears as your replies land.
     After answering all, re-enter with `revizorro review --worktree` to wait for
     the human's next decision. Loop back to step 2.

   - **`closed`** — the human closed the review tab without a verdict, so they
     interrupted the review on purpose. Do NOT re-arm blindly, do NOT merge, and
     do NOT keep working as if nothing happened. Stop and ask what to do, offering
     exactly these three options:

     - **Re-run the review** — reopen the form on the current diff
       (`revizorro review --worktree` reopens the same round) and continue the loop.
     - **Commit as is** — leave the review loop and commit the worktree as it stands.
     - **Chat about this** — leave the loop and discuss the change in chat instead.

     Ask in the language the user has been writing in: translate the question and
     the three labels into that language, keeping their meaning. Never answer in
     English to a user who writes in another language. Wait for their answer before
     doing anything else.

## Push-file shape

`--push` reads a JSON file matching the protocol `PushPayload`:

```json
{
  "replies": [{ "threadId": "t1", "body": "It narrows the union to the non-null branch." }],
  "comments": [{ "file": "src/a.ts", "range": { "startLine": 12, "endLine": 14 }, "body": "Extracted into a helper." }]
}
```

`replies` answer existing threads; `comments` open new agent-authored threads on
the diff. Either array may be empty.

## Rules

- One event per call. Always re-enter the loop after acting — never assume the
  form closed.
- Do NOT merge on `changes_requested`. Fix, re-submit, and wait for `approved`.
- On `clarify`, only answer — never edit code.
- On `approved`, the review gate has passed — you may merge the worktree.
- On `closed`, the human interrupted the review — ask them to choose between
  re-running the review, committing as is, and chatting about it (in their own
  language). Never merge and never silently re-loop.
- The form opens in the VS Code window that owns the reviewed project. If the CLI
  warns on stderr that no window has this project open, tell the user which window
  the form went to — they may be watching the wrong one.
- A verdict is never lost between calls. If the human decided while you were not
  blocked on `review`, the next `revizorro review --worktree` returns that
  decision instead of opening a new round — so an approval that arrived while you
  were busy still reaches you.
- `revizorro review --check` is a cheap preflight: exit 10 means the diff has
  something to review, exit 0 means it is empty. It touches no VS Code window, so
  use it before opening a form on an empty change. It honours `--staged-only`
  and `--base`.
- Review before committing, not after: stage the commit's contents, run
  `--staged-only`, and commit once it is approved.
