import type { DiffFile } from "@revizorro/core";
import type { SessionState } from "@revizorro/protocol";

import type { DiffCache } from "./diff-cache.js";

/** What the form shows at a glance, read synchronously when a poll times out. */
export interface ReviewSnapshot {
  round: number;
  files: number;
  openThreads: number;
  viewedFiles: number;
}

/**
 * Puts one review's state on its form, and remembers what the form shows — the idle
 * event and every outgoing event read that back synchronously, long after the
 * render that produced it.
 */
export class FormRenderer {
  /** Last rendered state, summarised for the idle event (read synchronously). */
  private lastSnapshot?: ReviewSnapshot;
  /** When the round on screen opened, read synchronously when an event goes out. */
  private openedAt?: number;

  constructor(
    private readonly paint: {
      render: (s: SessionState, diff: DiffFile[]) => void;
      open: (s: SessionState, diff: DiffFile[]) => void;
    },
    private readonly diff: DiffCache,
  ) {}

  /** Render into the open form, remembering what it shows for the idle snapshot. */
  render(s: SessionState): void {
    this.remember(s);
    this.paint.render(s, this.diff.current());
  }

  /** Open (or re-open) the form, remembering what it shows for the idle snapshot. */
  open(s: SessionState): void {
    this.remember(s);
    this.paint.open(s, this.diff.current());
  }

  snapshot(): ReviewSnapshot | undefined {
    return this.lastSnapshot;
  }

  roundOpenedAt(): number | undefined {
    return this.openedAt;
  }

  private remember(s: SessionState): void {
    this.openedAt = s.openedAt;
    const files = this.diff.current();
    const paths = new Set(files.map((f) => f.path));
    this.lastSnapshot = {
      round: s.round,
      files: files.length,
      openThreads: s.threads.filter((t) => !t.resolved && paths.has(t.file)).length,
      viewedFiles: files.filter((f) => s.files[f.path]?.viewed).length,
    };
  }
}
