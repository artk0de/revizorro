import { get } from "node:https";

/** npm's dist-tag document for the CLI: `latest` resolves to one published version. */
const LATEST_URL = "https://registry.npmjs.org/@revizorro%2Fcli/latest";
const TIMEOUT_MS = 5_000;

/**
 * Pulls the published version out of the registry's answer.
 *
 * Anything that is not a version string reads as "no target". The alternative —
 * trusting a malformed body — would pin garbage into every leg, and an install
 * of `@revizorro/cli@undefined` fails far away from the cause.
 */
export function parseLatest(body: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  const version = (doc as { version?: unknown } | null)?.version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

/** Asks npm which version is current; null on any network or shape failure. */
export async function fetchLatest(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const req = get(LATEST_URL, { timeout: TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve(parseLatest(body));
      });
    });
    req.on("timeout", () => {
      req.destroy();
    });
    req.on("error", () => {
      resolve(null);
    });
  });
}
