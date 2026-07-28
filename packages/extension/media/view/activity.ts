import { send } from "./bridge.js";

/**
 * How often a form in active use reports in. Long enough that a busy reviewer
 * costs two messages a minute at worst, short enough that a minutes-scale
 * absence threshold can never be crossed by a reader who is simply quiet.
 */
const THROTTLE_MS = 30_000;

/**
 * Tell the host a human is at the form. Bound to real input rather than a timer:
 * a timer would keep reporting activity from a tab left open on an empty desk,
 * which is precisely the lie this exists to remove.
 */
export function trackActivity(target: EventTarget, now: () => number = () => Date.now()): void {
  let lastSent = Number.NEGATIVE_INFINITY;
  const ping = (): void => {
    const t = now();
    if (t - lastSent < THROTTLE_MS) return;
    lastSent = t;
    send({ type: "activity" });
  };
  target.addEventListener("pointerdown", ping);
  target.addEventListener("keydown", ping);
}
