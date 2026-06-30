# revizorro (VS Code extension)

Hosts the local pre-merge review form for [revizorro](../../README.md): renders
the worktree diff with line-anchored comment threads (Comments API), approve /
decline, and viewed-collapse. Drives a localhost HTTP server that the `revizorro`
CLI long-polls — the agent opens the form, you review inline, the agent applies
fixes and re-submits until you approve.

On activation it writes its port to `<repoRoot>/.claude/revizorro/port` so the
CLI can find it.
