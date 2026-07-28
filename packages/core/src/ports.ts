import type { SessionState, ReviewEvent, PushPayload } from "@revizorro/protocol";
import type { DiffFile } from "./collapse.js";

export interface SessionStore {
  load: (worktreeId: string) => Promise<SessionState | null>;
  save: (s: SessionState) => Promise<void>;
}

export interface DiffProvider {
  diff: (worktreeId: string) => Promise<DiffFile[]>;
}

/** Per-call review knobs the agent picks on the command line. */
export interface ReviewOptions {
  /** Review the index against HEAD instead of the branch against its target. */
  stagedOnly?: boolean;
  /** Target branch to review against; auto-detected when absent. Ignored by --staged-only. */
  baseRef?: string;
}

export interface ReviewTransport {
  review: (
    worktreeId: string,
    repoRoot: string,
    push?: PushPayload,
    opts?: ReviewOptions,
  ) => Promise<ReviewEvent>;
}

export interface FormPort {
  open: (state: SessionState) => Promise<void>;
  nextEvent: (worktreeId: string) => Promise<ReviewEvent>;
}
