import { GitDiffProvider } from "@revizorro/core-adapters";
import type { DiffFile } from "@revizorro/core";

import type { ReviewIdentity } from "./review-identity.js";

/**
 * The diff one review last read, kept so a render, a snapshot or a verdict can use
 * it without a git walk. Re-read whenever the tree may have moved; read on first use
 * when nothing has been read yet.
 */
export class DiffCache {
  private readonly provider: GitDiffProvider;
  private readonly worktreeId: string;
  private files: DiffFile[] = [];

  constructor(identity: ReviewIdentity) {
    this.worktreeId = identity.worktreeId;
    // The diff source is baked into the provider, so a different scope is a
    // different session rather than a mutation of this one.
    this.provider = new GitDiffProvider(identity.repoRoot, identity.baseRef || undefined, {
      stagedOnly: identity.stagedOnly,
    });
  }

  /** What was read last — empty until the first read. */
  current(): DiffFile[] {
    return this.files;
  }

  /** Read the diff from the tree as it stands now. */
  async reread(): Promise<DiffFile[]> {
    this.files = await this.provider.diff(this.worktreeId);
    return this.files;
  }

  /** Read the diff only if nothing has been read yet. */
  async ensure(): Promise<void> {
    if (this.files.length === 0) await this.reread();
  }

  paths(): string[] {
    return this.files.map((f) => f.path);
  }
}
