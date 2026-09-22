const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * A duration written the way a human reads one, coarsening as it grows: tenths below
 * a second (so an instant answer reads as instant), whole seconds up to a minute,
 * then minutes, then hours. Always truncates, never rounds up into the next unit —
 * "1m" for 59.6 seconds would overstate a number the agent quotes verbatim.
 */
export function formatDuration(ms: number): string {
  // Two clocks are involved — the host stamps, the CLI subtracts — so a backwards
  // jump between them is possible, and "-3s" in a report is worse than "0.0s".
  const span = Math.max(0, ms);
  if (span < SECOND) return `${(Math.floor(span / 100) / 10).toFixed(1)}s`;
  if (span < MINUTE) return `${Math.floor(span / SECOND)}s`;
  if (span < HOUR) {
    const minutes = Math.floor(span / MINUTE);
    const seconds = Math.floor((span % MINUTE) / SECOND);
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(span / HOUR);
  const minutes = Math.floor((span % HOUR) / MINUTE);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
