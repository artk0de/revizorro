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

   - **`comment`** `{ threadId, file, side, range, body }` — a passive comment. You
     will not normally see one: comments the human leaves while reading no longer
     wake you, and reach you inside the verdict instead. If one does arrive (an
     older host), it is READ-ONLY — do NOT edit code and do NOT reply. Loop back to
     step 2.

   - **`idle`** — the poll hit its ceiling. This is the normal heartbeat of a
     review, not a fault. Re-arm:

     ```bash
     revizorro review
     ```

     Re-arm with NO scope flags: a bare call keeps reviewing whatever the round is
     already showing, while `--worktree` would widen a staged-only review to the
     whole branch.

     `idle` carries `inactiveForMs` — how long the form has gone untouched.
     Reading, expanding context and marking files viewed emit no events, so this
     number, not the number of `idle` events, is what tells you where the human
     is. Wait a MINIMUM of ten minutes of it before reading anything into silence:

     - **Under ten minutes: re-arm silently.** Say nothing to the user, do not
       check whether the form opened, do not inspect the host registry, do not
       restart anything. A careful reader is quiet for long stretches; that is
       what reviewing looks like.
     - **Ten minutes or more: tell the user ONCE**, in their language, that the
       form has not been touched for that long — then keep re-arming silently.
       Repeat it only if activity resumes and then stops again. Never end the
       loop: Approve still unblocks you the moment they come back, and an
       abandoned loop would leave them approving into a form nobody is listening
       to.

     `idle` also carries a `review` snapshot — `round`, `files`, `openThreads`,
     `viewedFiles` — which is proof the round is live. Watch `viewedFiles` climb if
     you want to see progress. If that snapshot is missing across several `idle`
     events in a row, THEN something is off and it is worth telling the user.

   - **`decision` / `approved`** — the human approved. Stop the loop. Proceed to
     merge (or report ready-to-merge).

   - **`decision` / `changes_requested`** `{ comments: [...] }` — NOW apply fixes
     for every comment. **Check `verdict` before you touch anything.** A `clarify`
     arrives carrying an identical `comments` array, so the payload cannot tell you
     which of the two you are in — only the `verdict` field can, and editing code on
     the wrong one is the single most expensive mistake in this loop. For each addressed comment, `--push` a reply into its
     thread saying what you did (so the human can verify and mark it resolved) —
     all of them in ONE push, not one call per comment.
     Then start a NEW round, keeping the same scope (no flags):

     ```bash
     revizorro review
     ```

     **Questions you asked that came back unanswered do not become permission to
     guess.** Fix what is unambiguous; for the rest, reply in the thread saying
     exactly what is still undecided and what you would do by default, and leave
     the code alone. A wrong fix costs the human more than an unanswered question.

     Unchanged files the human already marked viewed will be collapsed. Loop back
     to step 2.

   - **`decision` / `clarify`** `{ comments: [...] }` — a conversation, NOT a work
     order. Do not edit a single line of code here, however obvious the fix looks.

     This event looks EXACTLY like `changes_requested` — same `type`, same
     `comments` array — and the only thing separating them is `verdict`. If you
     reached for the editor because the comments read like fixes to make, you have
     misread the event: re-read `verdict`, put the file back, and answer instead.

     Answer EVERY comment in the list, and where a request is ambiguous, **ask
     back**: name the options you see and say which you would pick. Silently
     guessing what the human meant is the failure this event exists to prevent.
     Put all the replies and questions into ONE push file rather than pushing them
     one at a time. The form stays open and marks each unanswered thread, clearing
     as your replies land.

     After answering all, re-enter with `revizorro review` to wait for the human's
     next decision. Loop back to step 2.

   - **`closed`** — the human closed the review tab without a verdict, so they
     interrupted the review on purpose. Do NOT re-arm blindly, do NOT merge, and
     do NOT keep working as if nothing happened. Stop and ask what to do, offering
     exactly these three options:

     - **Re-run the review** — reopen the form on the current diff
       (`revizorro review` starts a fresh round in the same scope) and continue the loop.
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

**Answer every thread in ONE push.** Both arrays take as many entries as you
like, each `reply` addressed by its own `threadId`, and they are applied together
in a single round-trip. Answering five questions with five `--push` calls costs
five blocking waits and leaves the human watching four threads sit unanswered
while you work through them one by one:

```json
{
  "replies": [
    { "threadId": "t12", "body": "Renamed it to `refreshTokens!`." },
    { "threadId": "t13", "body": "It cannot be null here — the column is NOT NULL." },
    { "threadId": "t14", "body": "Extracted into TokenRefreshable." }
  ],
  "comments": []
}
```

Write every answer first, then push once.

## Rules

- One event per call. Always re-enter the loop after acting — never assume the
  form closed.
- **Only Ask agent is reactive.** `question` is the ONLY event you answer on your
  own initiative. Every other action of yours waits for a decision: `approved`,
  `changes_requested` or `clarify`. Comments piling up in the form are not a cue
  to start fixing — the human is still reviewing, and the fixes they want arrive
  as `changes_requested`.
- Do NOT merge on `changes_requested`. Fix, re-submit, and wait for `approved`.
- On `clarify`, only answer and ask back — never edit code. Unanswered questions
  are not permission to guess: on the next `changes_requested`, fix what is
  unambiguous and say in the thread what is still undecided.
- On `approved`, the review gate has passed — you may merge the worktree.
- On `closed`, the human interrupted the review — ask them to choose between
  re-running the review, committing as is, and chatting about it (in their own
  language). Never merge and never silently re-loop.
- The form opens in the VS Code window that owns the reviewed project. If the CLI
  warns on stderr that no window has this project open, tell the user which window
  the form went to — they may be watching the wrong one.
- A verdict is never lost between calls. If the human decided while you were not
  blocked on `review`, the next `revizorro review` returns that decision instead
  of opening a new round — so an approval that arrived while you were busy still
  reaches you.
- Re-arm with a bare `revizorro review`. Scope flags belong on the call that
  STARTS a review; repeating `--worktree` on every loop would widen a staged-only
  review to the whole branch.
- Judge an event by what it says, not by how long the call took. Every event
  carries `at` (when the human acted) and, when it waited in the queue while you
  were away, `held: true`. A verdict that arrives the instant you call is normal
  if `held` is set — it is a real decision made moments ago and handed over now,
  not a stale replay. Trust it and act; do not ask the user to confirm it.
- Answer all open threads in a single `--push` (see Push-file shape), never one
  call per thread.
- `revizorro review --check` is a cheap preflight: exit 10 means the diff has
  something to review, exit 0 means it is empty. It touches no VS Code window, so
  use it before opening a form on an empty change. It honours `--staged-only`
  and `--base`.
- Review before committing, not after: stage the commit's contents, run
  `--staged-only`, and commit once it is approved.
- **Merges do not start a review loop.** A merge commit carries no authored work
  — the review happened on the branch before it. Do not run `revizorro review`
  for a merge, and do not treat a merge as an unreviewed change.
