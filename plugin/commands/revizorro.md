---
description: Run a local pre-merge review of the current worktree diff in VS Code
---

Invoke the `revizorro` skill to open a VS Code review of the current worktree
diff and drive the human-in-the-loop review until approval. Follow the skill's
event loop exactly: one event per `revizorro review` call, re-enter after acting,
never merge on decline.
