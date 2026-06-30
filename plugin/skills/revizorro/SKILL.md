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

- The revizorro VS Code extension is installed and the workspace is open (it
  writes `.claude/revizorro/port`).
- `revizorro` is on PATH (`npm i -g @revizorro/cli`).

If `revizorro review` exits non-zero with a missing-port / connection error,
tell the user to open the project in VS Code with the extension active, then
retry.

## The loop

1. Start a round:

   ```bash
   revizorro review --worktree
   ```

   It blocks. When it returns, parse the single JSON event from stdout.

2. Branch on `event.type`:

   - **`question`** `{ threadId, file, range, body }` — the human asked you
     something about a specific line range. Compose an answer, write it to a push
     file, and re-enter the form (the form stays open):

     ```bash
     # write {"replies":[{"threadId":"<id>","body":"<your answer>"}],"comments":[]}
     # to $CLAUDE_JOB_DIR/tmp/revizorro-push.json (or a temp file)
     revizorro review --push "$CLAUDE_JOB_DIR/tmp/revizorro-push.json"
     ```

     Then loop back to step 2 with the next event.

   - **`comment`** `{ threadId, file, range, body }` — a passive comment. Note it,
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
