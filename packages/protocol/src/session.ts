import { z } from "zod";
import { FileRange, Side } from "./range.js";

export const FileViewState = z.object({ viewed: z.boolean(), contentHash: z.string() });
export const ThreadMessage = z.object({ author: z.enum(["human", "agent"]), body: z.string() });
export const Thread = z.object({
  id: z.string(),
  file: z.string(),
  side: Side.default("new"),
  range: FileRange,
  messages: z.array(ThreadMessage).min(1),
  resolved: z.boolean().default(false),
});
export const SessionState = z.object({
  worktreeId: z.string(),
  round: z.number().int().positive(),
  status: z.enum(["open", "approved", "changes_requested"]),
  files: z.record(z.string(), FileViewState),
  threads: z.array(Thread).default([]),
  /**
   * Whether a decided verdict already reached an agent. A human can approve while
   * no `review` call is blocked, and the event would be emitted into the void — an
   * undelivered verdict is replayed on the next review instead of being lost.
   */
  verdictDelivered: z.boolean().default(false),
});
export type SessionState = z.infer<typeof SessionState>;
export type Thread = z.infer<typeof Thread>;
export type FileViewState = z.infer<typeof FileViewState>;
