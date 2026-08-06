// The rule lives with the other git-touching adapters, because the extension needs
// the very same identity to find a session again after a window reload. Re-exported
// here so `@revizorro/cli` keeps its published surface.
export { resolveWorktreeId, worktreeIdFor } from "@revizorro/core-adapters";
