import type { SessionState, ReviewEvent, PushPayload } from "@revizorro/protocol";
import type { DiffFile } from "./collapse.js";

export interface SessionStore {
  load: (worktreeId: string) => Promise<SessionState | null>;
  save: (s: SessionState) => Promise<void>;
}

export interface DiffProvider {
  diff: (worktreeId: string) => Promise<DiffFile[]>;
}

export interface ReviewTransport {
  review: (worktreeId: string, repoRoot: string, push?: PushPayload) => Promise<ReviewEvent>;
}

export interface FormPort {
  open: (state: SessionState) => Promise<void>;
  nextEvent: (worktreeId: string) => Promise<ReviewEvent>;
}
