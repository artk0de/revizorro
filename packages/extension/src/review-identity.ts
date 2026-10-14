/** Everything a review of one worktree is, at one scope: its identity and its state. */
export interface ReviewIdentity {
  repoRoot: string;
  worktreeId: string;
  /** The CLI asked to review the index only — unstaged edits stay out of the diff. */
  stagedOnly: boolean;
  /** Branch under review. Part of the session key, so a checkout starts fresh. */
  branch: string;
  /** Target branch the CLI asked to review against ("" = auto-detect). */
  baseRef: string;
}
