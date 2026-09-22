import { describe, it, expect } from "vitest";
import { formatDuration } from "../src/duration.js";

// The milliseconds are for the agent's threshold checks; this string is what it
// repeats back to the human, so nobody has to divide by 60000 in their head.
describe("formatDuration", () => {
  it("keeps a tenth of a second below one second, so an instant answer reads as instant", () => {
    expect(formatDuration(240)).toBe("0.2s");
    expect(formatDuration(999)).toBe("0.9s");
  });
  it("reads zero as a duration rather than as an empty string", () => {
    expect(formatDuration(0)).toBe("0.0s");
  });
  it("truncates to whole seconds below a minute, never rounding up into the next unit", () => {
    expect(formatDuration(7_400)).toBe("7s");
    expect(formatDuration(59_600)).toBe("59s");
  });
  it("splits minutes from seconds, and says just the minutes when they divide evenly", () => {
    expect(formatDuration(187_204)).toBe("3m 7s");
    expect(formatDuration(1_260_000)).toBe("21m");
  });
  it("drops to hours and minutes past an hour, where the seconds stop carrying meaning", () => {
    expect(formatDuration(4_320_000)).toBe("1h 12m");
    expect(formatDuration(7_200_000)).toBe("2h");
  });
  it("reads a clock that jumped backwards as no time at all, not as a negative duration", () => {
    expect(formatDuration(-5_000)).toBe("0.0s");
  });
});
