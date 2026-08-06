import { describe, it, expect } from "vitest";
import { reviewThroughAnyWindow } from "../src/index.js";
import type { WindowSearch } from "../src/index.js";

const err = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

/** A search whose clock the test drives, so nothing here waits on wall time. */
const search = (over: Partial<WindowSearch<string>> = {}): WindowSearch<string> => {
  let ms = 0;
  return {
    hosts: () => [1],
    attempt: async () => "answered",
    drop: () => undefined,
    wait: async (by) => {
      ms += by;
    },
    elapsed: () => ms,
    ...over,
  };
};

describe("reviewThroughAnyWindow", () => {
  it("hands back the answer from the first window that responds", async () => {
    expect(await reviewThroughAnyWindow(search())).toBe("answered");
  });

  it("drops a dead window from the registry and moves on to the next", async () => {
    const dropped: number[] = [];
    const out = await reviewThroughAnyWindow(
      search({
        hosts: () => [1, 2],
        drop: (p) => dropped.push(p),
        attempt: async (port) => {
          if (port === 1) throw err("ECONNREFUSED");
          return "second window";
        },
      }),
    );

    expect({ out, dropped }).toEqual({ out: "second window", dropped: [1] });
  });

  // The whole point: a reloading window registers a NEW port, and a list captured
  // before the sweep began can never contain it.
  it("re-reads the registry, so a window that came back mid-search is found", async () => {
    let live: number[] = [1];
    const out = await reviewThroughAnyWindow(
      search({
        hosts: () => live,
        drop: () => {
          live = [];
        },
        wait: async () => {
          live = [7]; // the window finished reloading
        },
        attempt: async (port) => {
          if (port === 1) throw err("ECONNRESET");
          return `window ${port}`;
        },
      }),
    );

    expect(out).toBe("window 7");
  });

  it("keeps waiting while the registry is empty, rather than giving up on the gap", async () => {
    let sweeps = 0;
    let live: number[] = [];
    const out = await reviewThroughAnyWindow(
      search({
        hosts: () => {
          sweeps++;
          return live;
        },
        wait: async () => {
          if (sweeps >= 3) live = [4];
        },
        attempt: async () => "back up",
      }),
    );

    expect(out).toBe("back up");
  });

  // A push that reached a window is already persisted. Sending it again would put
  // the agent's replies into the human's threads twice.
  it("stops carrying the push once a connection died mid-flight", async () => {
    const carried: boolean[] = [];
    await reviewThroughAnyWindow(
      search({
        hosts: () => [1, 2],
        attempt: async (port, carryPush) => {
          carried.push(carryPush);
          if (port === 1) throw err("ECONNRESET");
          return "done";
        },
      }),
    );

    expect(carried).toEqual([true, false]);
  });

  it("still carries the push when the request never reached a window at all", async () => {
    const carried: boolean[] = [];
    await reviewThroughAnyWindow(
      search({
        hosts: () => [1, 2],
        attempt: async (port, carryPush) => {
          carried.push(carryPush);
          if (port === 1) throw err("ECONNREFUSED");
          return "done";
        },
      }),
    );

    expect(carried).toEqual([true, true]);
  });

  it("gives up once the grace period is spent", async () => {
    let ms = 0;
    await expect(
      reviewThroughAnyWindow(
        {
          hosts: () => [],
          attempt: async () => "never",
          drop: () => undefined,
          wait: async (by) => {
            ms += by;
          },
          elapsed: () => ms,
        },
        { graceMs: 500, pollMs: 100 },
      ),
    ).rejects.toThrow(/no live revizorro window/);
  });

  it("lets a real failure through instead of hunting for another window", async () => {
    await expect(
      reviewThroughAnyWindow(
        search({
          attempt: async () => {
            throw new Error("the diff blew up");
          },
        }),
      ),
    ).rejects.toThrow("the diff blew up");
  });
});
