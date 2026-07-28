/** What the file navigator shows next to one file. */
export interface FileReviewState {
  /** Threads still awaiting resolution — the number the human has to work through. */
  openThreads: number;
  /** Had threads, and every one of them is resolved. */
  allResolved: boolean;
  /** Still on the human's plate: an unresolved thread, or a diff not marked viewed. */
  needsAttention: boolean;
}

/**
 * Roll a file's threads and viewed flag into the state its navigator row shows.
 *
 * An unresolved thread always outranks the viewed tick: when the agent comments on
 * a file the human already ticked off, that file has to climb back onto the radar
 * instead of staying quietly greyed out.
 */
export function fileReviewState(
  threads: readonly { resolved: boolean }[],
  viewed: boolean,
): FileReviewState {
  const openThreads = threads.filter((t) => !t.resolved).length;
  return {
    openThreads,
    allResolved: threads.length > 0 && openThreads === 0,
    needsAttention: openThreads > 0 || !viewed,
  };
}
