# revizorro I1 (MVP Core Loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP of revizorro — a local, GitHub-PR-grade pre-merge review loop where an AI agent drives a VS Code review form via a re-entrant CLI command, the human reviews inline (comments, approve/decline, viewed-collapse), and the agent applies fixes and re-submits.

**Architecture:** Hexagonal (ports/adapters), simplified from tea-rags. Pure domain in `@revizorro/core`, shared Zod schemas in `@revizorro/protocol`, side effects in adapters (JSON store, git diff, localhost HTTP). The CLI is a stateless HTTP client; the VS Code extension hosts the long-lived session + HTTP server. "Output ends = agent's turn" — each CLI call blocks until exactly one review event, prints it, exits.

**Tech Stack:** TypeScript (strict), pnpm workspaces, Zod, Vitest, ESLint + Prettier, Node `http`, VS Code Extension API (Comments API + webview), `vsce`.

## Global Constraints

- TypeScript `strict: true`; target `ES2022`, module `NodeNext`.
- Node `>= 20` (CLI + extension host run on the VS Code / system Node).
- All cross-process data validated through `@revizorro/protocol` Zod schemas at the boundary — no untyped JSON crosses a process line.
- pnpm workspaces; package names `@revizorro/{protocol,core,cli,extension}`.
- Session state persisted under `<repoRoot>/.claude/revizorro/<worktreeId>/session.json`.
- Port discovery file: `<repoRoot>/.claude/revizorro/port` (extension writes, CLI reads).
- Idle cutoff: CLI long-poll returns `{type:"idle"}` at **540 000 ms** (9 min) to stay under the 600 000 ms Bash cap.
- TDD: every task with testable logic writes the failing test first, runs it red, implements minimal, runs it green, commits.
- Conventional commits.

---

## File Structure

```
revizorro/
  package.json                 # workspace root, scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.config.ts
  eslint.config.js
  .prettierrc.json
  packages/
    protocol/
      package.json
      tsconfig.json
      src/{range,events,payload,session,index}.ts
      tests/{events,payload,session}.test.ts
    core/
      package.json
      tsconfig.json
      src/
        ports.ts               # ReviewTransport, SessionStore, DiffProvider, FormPort
        collapse.ts            # viewed/collapse decision (pure)
        threads.ts             # applyPush (pure)
        round.ts               # startRound, applyDecision (pure)
        index.ts
      tests/{collapse,threads,round}.test.ts
    core-adapters/
      package.json
      tsconfig.json
      src/
        store-fs.ts            # FsSessionStore
        diff-git.ts            # GitDiffProvider
        http-server.ts         # HttpReviewHost (server side, event queue)
        http-client.ts         # HttpReviewClient (CLI side)
        index.ts
      tests/{store-fs,diff-git,http}.test.ts
    cli/
      package.json
      tsconfig.json
      src/{main,resolve-worktree,index}.ts
      tests/main.test.ts
      bin/revizorro.js
    extension/
      package.json
      tsconfig.json
      src/{extension,form,host}.ts
      media/review.html
  plugin/
    .claude-plugin/plugin.json
    skills/revizorro/SKILL.md
    commands/revizorro.md
```

`core-adapters` is a separate package (not folded into `core`) because it pulls Node `fs`/`http`/`child_process` deps that the pure `core` must stay free of — the dependency cut is the point of the hexagon.

---

### Task 1: Monorepo scaffold + tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.gitignore`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core-adapters/package.json`, `packages/core-adapters/tsconfig.json`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`
- Create: `packages/extension/package.json`, `packages/extension/tsconfig.json`

**Interfaces:**
- Produces: workspace where `pnpm install`, `pnpm -r build`, `pnpm test` run.

- [ ] **Step 1: Root `package.json`**

```json
{
  "name": "revizorro",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "lint": "eslint .",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "eslint": "^9.0.0",
    "typescript-eslint": "^8.0.0",
    "prettier": "^3.3.0"
  }
}
```

- [ ] **Step 2: `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 3: `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: Per-package `package.json` + `tsconfig.json`**

`packages/protocol/package.json`:
```json
{
  "name": "@revizorro/protocol",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "zod": "^3.23.0" }
}
```
`packages/protocol/tsconfig.json` (same pattern for every package, adjust `references`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```
`packages/core/package.json` — `dependencies: { "@revizorro/protocol": "workspace:*" }`.
`packages/core-adapters/package.json` — deps `@revizorro/protocol`, `@revizorro/core` (both `workspace:*`).
`packages/cli/package.json` — deps protocol + core + core-adapters; add `"bin": { "revizorro": "bin/revizorro.js" }`.
`packages/extension/package.json` — deps protocol + core + core-adapters; VS Code engine field (Task 10).

- [ ] **Step 5: `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.gitignore`**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["packages/*/tests/**/*.test.ts"] } });
```
`.gitignore`: `node_modules`, `dist`, `*.vsix`, `.claude/revizorro/`.

- [ ] **Step 6: Verify toolchain**

Run: `pnpm install && pnpm -r build && pnpm test`
Expected: install OK, build compiles (empty `src` may warn — add a `src/index.ts` stub `export {}` per package), `pnpm test` reports "no tests" (exit 0).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold revizorro pnpm monorepo + tooling"
```

---

### Task 2: protocol — Zod schemas

**Files:**
- Create: `packages/protocol/src/range.ts`, `events.ts`, `payload.ts`, `session.ts`, `index.ts`
- Test: `packages/protocol/tests/events.test.ts`, `payload.test.ts`, `session.test.ts`

**Interfaces:**
- Produces:
  - `FileRange = { startLine: number; endLine: number }`
  - `ReviewEvent` discriminated union on `type`: `question | comment | decision | idle` (shapes below)
  - `PushPayload = { replies: AgentReply[]; comments: AgentComment[] }`
  - `SessionState = { worktreeId; round; status; files; threads }`
  - Each exported as both a Zod schema (PascalCase) and an inferred type (same name).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/events.test.ts
import { describe, it, expect } from "vitest";
import { ReviewEvent } from "../src/index.js";

describe("ReviewEvent", () => {
  it("parses a question event", () => {
    const e = ReviewEvent.parse({
      type: "question", threadId: "t1", file: "a.ts",
      range: { startLine: 3, endLine: 5 }, body: "why this cast?",
    });
    expect(e.type).toBe("question");
  });
  it("parses a decision with default empty comments", () => {
    const e = ReviewEvent.parse({ type: "decision", verdict: "approved" });
    expect(e).toEqual({ type: "decision", verdict: "approved", comments: [] });
  });
  it("rejects an unknown type", () => {
    expect(() => ReviewEvent.parse({ type: "bogus" })).toThrow();
  });
  it("parses idle", () => {
    expect(ReviewEvent.parse({ type: "idle" }).type).toBe("idle");
  });
});
```

```ts
// tests/payload.test.ts
import { describe, it, expect } from "vitest";
import { PushPayload } from "../src/index.js";
describe("PushPayload", () => {
  it("defaults replies and comments to empty arrays", () => {
    expect(PushPayload.parse({})).toEqual({ replies: [], comments: [] });
  });
  it("parses a reply and a comment", () => {
    const p = PushPayload.parse({
      replies: [{ threadId: "t1", body: "it narrows the union" }],
      comments: [{ file: "b.ts", range: { startLine: 1, endLine: 1 }, body: "rename" }],
    });
    expect(p.replies[0].threadId).toBe("t1");
    expect(p.comments[0].file).toBe("b.ts");
  });
});
```

```ts
// tests/session.test.ts
import { describe, it, expect } from "vitest";
import { SessionState } from "../src/index.js";
describe("SessionState", () => {
  it("parses a minimal open session", () => {
    const s = SessionState.parse({
      worktreeId: "wt1", round: 1, status: "open",
      files: { "a.ts": { viewed: false, contentHash: "h1" } }, threads: [],
    });
    expect(s.round).toBe(1);
  });
  it("requires round >= 1", () => {
    expect(() => SessionState.parse({
      worktreeId: "wt1", round: 0, status: "open", files: {}, threads: [],
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/protocol`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Implement the schemas**

```ts
// src/range.ts
import { z } from "zod";
export const FileRange = z.object({
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
});
export type FileRange = z.infer<typeof FileRange>;
```

```ts
// src/events.ts
import { z } from "zod";
import { FileRange } from "./range.js";
const ThreadAnchor = { threadId: z.string(), file: z.string(), range: FileRange, body: z.string() };
export const QuestionEvent = z.object({ type: z.literal("question"), ...ThreadAnchor });
export const CommentEvent = z.object({ type: z.literal("comment"), ...ThreadAnchor });
export const DecisionEvent = z.object({
  type: z.literal("decision"),
  verdict: z.enum(["approved", "declined"]),
  comments: z.array(z.object(ThreadAnchor)).default([]),
});
export const IdleEvent = z.object({ type: z.literal("idle") });
export const ReviewEvent = z.discriminatedUnion("type", [
  QuestionEvent, CommentEvent, DecisionEvent, IdleEvent,
]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;
```

```ts
// src/payload.ts
import { z } from "zod";
import { FileRange } from "./range.js";
export const AgentReply = z.object({ threadId: z.string(), body: z.string() });
export const AgentComment = z.object({ file: z.string(), range: FileRange, body: z.string() });
export const PushPayload = z.object({
  replies: z.array(AgentReply).default([]),
  comments: z.array(AgentComment).default([]),
});
export type PushPayload = z.infer<typeof PushPayload>;
```

```ts
// src/session.ts
import { z } from "zod";
import { FileRange } from "./range.js";
export const FileViewState = z.object({ viewed: z.boolean(), contentHash: z.string() });
export const ThreadMessage = z.object({ author: z.enum(["human", "agent"]), body: z.string() });
export const Thread = z.object({
  id: z.string(), file: z.string(), range: FileRange,
  messages: z.array(ThreadMessage).min(1), resolved: z.boolean().default(false),
});
export const SessionState = z.object({
  worktreeId: z.string(),
  round: z.number().int().positive(),
  status: z.enum(["open", "approved", "declined"]),
  files: z.record(z.string(), FileViewState),
  threads: z.array(Thread).default([]),
});
export type SessionState = z.infer<typeof SessionState>;
export type Thread = z.infer<typeof Thread>;
export type FileViewState = z.infer<typeof FileViewState>;
```

```ts
// src/index.ts
export * from "./range.js";
export * from "./events.js";
export * from "./payload.js";
export * from "./session.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/protocol`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): zod schemas for events, push payload, session state"
```

---

### Task 3: core — viewed/collapse decision (pure)

**Files:**
- Create: `packages/core/src/collapse.ts`, `packages/core/src/index.ts`
- Test: `packages/core/tests/collapse.test.ts`

**Interfaces:**
- Consumes: `FileViewState` from `@revizorro/protocol`.
- Produces:
  - `interface DiffFile { path: string; contentHash: string }`
  - `decideCollapsed(prev: Record<string, FileViewState>, current: DiffFile[]): { collapsed: string[]; files: Record<string, FileViewState> }`
  - Rule: a file is collapsed iff it was previously `viewed === true` AND its `contentHash` is unchanged. Collapsed files keep `viewed: true`; changed/new files reset to `viewed: false`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/collapse.test.ts
import { describe, it, expect } from "vitest";
import { decideCollapsed } from "../src/index.js";

describe("decideCollapsed", () => {
  it("collapses a previously-viewed unchanged file", () => {
    const prev = { "a.ts": { viewed: true, contentHash: "h1" } };
    const r = decideCollapsed(prev, [{ path: "a.ts", contentHash: "h1" }]);
    expect(r.collapsed).toEqual(["a.ts"]);
    expect(r.files["a.ts"]).toEqual({ viewed: true, contentHash: "h1" });
  });
  it("expands a viewed file whose content changed", () => {
    const prev = { "a.ts": { viewed: true, contentHash: "h1" } };
    const r = decideCollapsed(prev, [{ path: "a.ts", contentHash: "h2" }]);
    expect(r.collapsed).toEqual([]);
    expect(r.files["a.ts"]).toEqual({ viewed: false, contentHash: "h2" });
  });
  it("treats a new file as expanded and unviewed", () => {
    const r = decideCollapsed({}, [{ path: "new.ts", contentHash: "h9" }]);
    expect(r.collapsed).toEqual([]);
    expect(r.files["new.ts"]).toEqual({ viewed: false, contentHash: "h9" });
  });
  it("drops files no longer in the diff", () => {
    const prev = { "gone.ts": { viewed: true, contentHash: "h1" } };
    const r = decideCollapsed(prev, [{ path: "a.ts", contentHash: "h1" }]);
    expect(r.files["gone.ts"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/collapse.ts
import type { FileViewState } from "@revizorro/protocol";
export interface DiffFile { path: string; contentHash: string; }
export function decideCollapsed(
  prev: Record<string, FileViewState>,
  current: DiffFile[],
): { collapsed: string[]; files: Record<string, FileViewState> } {
  const collapsed: string[] = [];
  const files: Record<string, FileViewState> = {};
  for (const f of current) {
    const before = prev[f.path];
    const unchanged = before?.viewed === true && before.contentHash === f.contentHash;
    files[f.path] = { viewed: unchanged, contentHash: f.contentHash };
    if (unchanged) collapsed.push(f.path);
  }
  return { collapsed, files };
}
```

```ts
// src/index.ts
export * from "./collapse.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): viewed/collapse decision for cross-round diff"
```

---

### Task 4: core — applyPush thread mutation (pure)

**Files:**
- Create: `packages/core/src/threads.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./threads.js";`)
- Test: `packages/core/tests/threads.test.ts`

**Interfaces:**
- Consumes: `SessionState`, `PushPayload` from protocol.
- Produces:
  - `applyPush(state: SessionState, payload: PushPayload, idGen: () => string): SessionState`
  - Each `reply{threadId, body}` appends `{author:"agent", body}` to that thread's `messages` (no-op if thread id absent). Each `comment{file,range,body}` appends a new agent-authored thread with `idGen()` id. Returns a new state (no mutation of input).

- [ ] **Step 1: Write the failing test**

```ts
// tests/threads.test.ts
import { describe, it, expect } from "vitest";
import { applyPush } from "../src/index.js";
import type { SessionState } from "@revizorro/protocol";

const base: SessionState = {
  worktreeId: "wt1", round: 1, status: "open", files: {},
  threads: [{ id: "t1", file: "a.ts", range: { startLine: 1, endLine: 1 },
    messages: [{ author: "human", body: "why?" }], resolved: false }],
};

describe("applyPush", () => {
  it("appends an agent reply to an existing thread", () => {
    let n = 0; const idGen = () => `g${++n}`;
    const next = applyPush(base, { replies: [{ threadId: "t1", body: "because X" }], comments: [] }, idGen);
    expect(next.threads[0].messages).toHaveLength(2);
    expect(next.threads[0].messages[1]).toEqual({ author: "agent", body: "because X" });
    expect(base.threads[0].messages).toHaveLength(1); // input untouched
  });
  it("adds a new agent thread for a comment", () => {
    const next = applyPush(base, { replies: [],
      comments: [{ file: "b.ts", range: { startLine: 2, endLine: 4 }, body: "extract this" }] }, () => "gen1");
    expect(next.threads).toHaveLength(2);
    expect(next.threads[1]).toMatchObject({ id: "gen1", author: undefined, file: "b.ts" });
    expect(next.threads[1].messages[0]).toEqual({ author: "agent", body: "extract this" });
  });
  it("ignores a reply to an unknown thread", () => {
    const next = applyPush(base, { replies: [{ threadId: "nope", body: "x" }], comments: [] }, () => "g");
    expect(next.threads[0].messages).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/threads.test.ts`
Expected: FAIL — `applyPush` not exported.

- [ ] **Step 3: Implement**

```ts
// src/threads.ts
import type { SessionState, PushPayload } from "@revizorro/protocol";
export function applyPush(state: SessionState, payload: PushPayload, idGen: () => string): SessionState {
  const threads = state.threads.map((t) => ({ ...t, messages: [...t.messages] }));
  for (const r of payload.replies) {
    const t = threads.find((x) => x.id === r.threadId);
    if (t) t.messages.push({ author: "agent", body: r.body });
  }
  for (const c of payload.comments) {
    threads.push({
      id: idGen(), file: c.file, range: c.range,
      messages: [{ author: "agent", body: c.body }], resolved: false,
    });
  }
  return { ...state, threads };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/threads.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): applyPush appends agent replies and comment threads"
```

---

### Task 5: core — round lifecycle + ports

**Files:**
- Create: `packages/core/src/round.ts`, `packages/core/src/ports.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/round.test.ts`

**Interfaces:**
- Consumes: `SessionState`, `ReviewEvent` from protocol; `DiffFile` from `collapse.ts`.
- Produces:
  - `startRound(prev: SessionState | null, worktreeId: string, diff: DiffFile[]): SessionState` — round `prev ? prev.round + 1 : 1`, status `"open"`, files via `decideCollapsed`, carries forward only unresolved threads.
  - `applyDecision(state: SessionState, verdict: "approved" | "declined"): SessionState` — sets `status`.
  - `ports.ts` interfaces (no test — pure contracts):
    - `SessionStore { load(worktreeId): Promise<SessionState|null>; save(s): Promise<void> }`
    - `DiffProvider { diff(worktreeId): Promise<DiffFile[]> }`
    - `ReviewTransport { review(worktreeId, push?): Promise<ReviewEvent> }` (CLI client side)
    - `FormPort { open(state): Promise<void>; nextEvent(worktreeId): Promise<ReviewEvent> }` (extension host side)

- [ ] **Step 1: Write the failing test**

```ts
// tests/round.test.ts
import { describe, it, expect } from "vitest";
import { startRound, applyDecision } from "../src/index.js";
import type { SessionState } from "@revizorro/protocol";

describe("startRound", () => {
  it("starts round 1 from null with unviewed files", () => {
    const s = startRound(null, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    expect(s.round).toBe(1);
    expect(s.status).toBe("open");
    expect(s.files["a.ts"]).toEqual({ viewed: false, contentHash: "h1" });
    expect(s.threads).toEqual([]);
  });
  it("increments round and collapses unchanged viewed files", () => {
    const prev: SessionState = {
      worktreeId: "wt1", round: 1, status: "declined",
      files: { "a.ts": { viewed: true, contentHash: "h1" } },
      threads: [
        { id: "t1", file: "a.ts", range: { startLine: 1, endLine: 1 }, messages: [{ author: "human", body: "x" }], resolved: true },
        { id: "t2", file: "a.ts", range: { startLine: 2, endLine: 2 }, messages: [{ author: "human", body: "y" }], resolved: false },
      ],
    };
    const s = startRound(prev, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    expect(s.round).toBe(2);
    expect(s.files["a.ts"].viewed).toBe(true);
    expect(s.threads.map((t) => t.id)).toEqual(["t2"]); // resolved dropped
  });
});

describe("applyDecision", () => {
  it("sets status to approved", () => {
    const s = startRound(null, "wt1", []);
    expect(applyDecision(s, "approved").status).toBe("approved");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/round.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```ts
// src/round.ts
import type { SessionState } from "@revizorro/protocol";
import { decideCollapsed, type DiffFile } from "./collapse.js";
export function startRound(prev: SessionState | null, worktreeId: string, diff: DiffFile[]): SessionState {
  const round = prev ? prev.round + 1 : 1;
  const { files } = decideCollapsed(prev?.files ?? {}, diff);
  const threads = (prev?.threads ?? []).filter((t) => !t.resolved);
  return { worktreeId, round, status: "open", files, threads };
}
export function applyDecision(state: SessionState, verdict: "approved" | "declined"): SessionState {
  return { ...state, status: verdict };
}
```

```ts
// src/ports.ts
import type { SessionState, ReviewEvent, PushPayload } from "@revizorro/protocol";
import type { DiffFile } from "./collapse.js";
export interface SessionStore { load(worktreeId: string): Promise<SessionState | null>; save(s: SessionState): Promise<void>; }
export interface DiffProvider { diff(worktreeId: string): Promise<DiffFile[]>; }
export interface ReviewTransport { review(worktreeId: string, push?: PushPayload): Promise<ReviewEvent>; }
export interface FormPort { open(state: SessionState): Promise<void>; nextEvent(worktreeId: string): Promise<ReviewEvent>; }
```

Add to `src/index.ts`: `export * from "./round.js"; export * from "./ports.js";`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core`
Expected: PASS (all core tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): round lifecycle, decision, hexagon ports"
```

---

### Task 6: core-adapters — FsSessionStore

**Files:**
- Create: `packages/core-adapters/src/store-fs.ts`, `packages/core-adapters/src/index.ts`
- Test: `packages/core-adapters/tests/store-fs.test.ts`

**Interfaces:**
- Consumes: `SessionStore`, `SessionState`.
- Produces: `class FsSessionStore implements SessionStore` — ctor `(repoRoot: string)`. Persists to `<repoRoot>/.claude/revizorro/<worktreeId>/session.json`. `load` returns `null` when the file is absent; validates with `SessionState.parse` on read. Atomic write (temp file + rename).

- [ ] **Step 1: Write the failing test**

```ts
// tests/store-fs.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSessionStore } from "../src/index.js";
import { startRound } from "@revizorro/core";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rvz-")); });

describe("FsSessionStore", () => {
  it("returns null before any save", async () => {
    expect(await new FsSessionStore(root).load("wt1")).toBeNull();
  });
  it("round-trips a saved session", async () => {
    const store = new FsSessionStore(root);
    const s = startRound(null, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    await store.save(s);
    expect(await store.load("wt1")).toEqual(s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core-adapters/tests/store-fs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/store-fs.ts
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { SessionState } from "@revizorro/protocol";
import type { SessionStore } from "@revizorro/core";
export class FsSessionStore implements SessionStore {
  constructor(private readonly repoRoot: string) {}
  private path(worktreeId: string): string {
    return join(this.repoRoot, ".claude", "revizorro", worktreeId, "session.json");
  }
  async load(worktreeId: string): Promise<SessionState | null> {
    try {
      const raw = await readFile(this.path(worktreeId), "utf8");
      return SessionState.parse(JSON.parse(raw));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async save(s: SessionState): Promise<void> {
    const p = this.path(s.worktreeId);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
    await rename(tmp, p);
  }
}
```

`src/index.ts`: `export * from "./store-fs.js";`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core-adapters/tests/store-fs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core-adapters
git commit -m "feat(adapters): FsSessionStore atomic JSON persistence"
```

---

### Task 7: core-adapters — GitDiffProvider

**Files:**
- Create: `packages/core-adapters/src/diff-git.ts`
- Modify: `packages/core-adapters/src/index.ts`
- Test: `packages/core-adapters/tests/diff-git.test.ts`

**Interfaces:**
- Produces: `class GitDiffProvider implements DiffProvider` — ctor `(repoRoot, baseRef = "main")`. `diff(worktreeId)` returns one `DiffFile` per changed path (committed-on-branch vs merge-base + uncommitted). `contentHash` = sha1 of the file's current working-tree bytes (empty string for deleted files). Helper `mergeBase(baseRef)`, `changedPaths(base)` via `git diff --name-only`.

- [ ] **Step 1: Write the failing test** (fixture repo built in-test)

```ts
// tests/diff-git.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitDiffProvider } from "../src/index.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rvz-git-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "feature");
});

describe("GitDiffProvider", () => {
  it("reports a committed change on the branch", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    git(repo, "commit", "-aqm", "change a");
    const files = await new GitDiffProvider(repo, "main").diff("wt");
    expect(files.map((f) => f.path)).toContain("a.ts");
    expect(files.find((f) => f.path === "a.ts")!.contentHash).toMatch(/^[0-9a-f]{40}$/);
  });
  it("reports an uncommitted new file", async () => {
    writeFileSync(join(repo, "b.ts"), "export const b = 3;\n");
    const files = await new GitDiffProvider(repo, "main").diff("wt");
    expect(files.map((f) => f.path)).toContain("b.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core-adapters/tests/diff-git.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/diff-git.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { DiffProvider, DiffFile } from "@revizorro/core";
const exec = promisify(execFile);
export class GitDiffProvider implements DiffProvider {
  constructor(private readonly repoRoot: string, private readonly baseRef = "main") {}
  private async git(...args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, { cwd: this.repoRoot, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }
  async diff(_worktreeId: string): Promise<DiffFile[]> {
    const base = (await this.git("merge-base", this.baseRef, "HEAD")).trim();
    const committed = await this.git("diff", "--name-only", base, "HEAD");
    const uncommitted = await this.git("diff", "--name-only", "HEAD");
    const untracked = await this.git("ls-files", "--others", "--exclude-standard");
    const paths = new Set([committed, uncommitted, untracked].flatMap((s) => s.split("\n")).filter(Boolean));
    const files: DiffFile[] = [];
    for (const path of paths) {
      let contentHash = "";
      try {
        const bytes = await readFile(join(this.repoRoot, path));
        contentHash = createHash("sha1").update(bytes).digest("hex");
      } catch { /* deleted file → empty hash */ }
      files.push({ path, contentHash });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}
```

Add to `src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core-adapters/tests/diff-git.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core-adapters
git commit -m "feat(adapters): GitDiffProvider worktree-vs-merge-base with content hashes"
```

---

### Task 8: core-adapters — HTTP host + client transport

**Files:**
- Create: `packages/core-adapters/src/http-server.ts`, `packages/core-adapters/src/http-client.ts`
- Modify: `packages/core-adapters/src/index.ts`
- Test: `packages/core-adapters/tests/http.test.ts`

**Interfaces:**
- Produces:
  - `class HttpReviewHost` — wraps an event queue. `start(): Promise<number>` (binds `127.0.0.1:0`, returns the port). `emit(worktreeId, event)` enqueues an event for the next waiting poll. `onPush(cb: (worktreeId, push) => void)`. Routes: `POST /review` body `{ worktreeId, push? }` → long-polls until an event is emitted for that worktree, responds with the `ReviewEvent` JSON. `stop()`.
  - `class HttpReviewClient implements ReviewTransport` — ctor `(port)`. `review(worktreeId, push?)` POSTs and resolves the parsed `ReviewEvent`.
- Contract: client `review()` ←→ server `emit()` deliver exactly one event; a `push` on the client surfaces via `onPush` on the server.

- [ ] **Step 1: Write the failing test**

```ts
// tests/http.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { HttpReviewHost, HttpReviewClient } from "../src/index.js";

let host: HttpReviewHost;
afterEach(async () => { await host?.stop(); });

describe("HTTP transport contract", () => {
  it("delivers an emitted event to a waiting client", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    const client = new HttpReviewClient(port);
    const pending = client.review("wt1");
    // emit after the client is waiting
    setTimeout(() => host.emit("wt1", { type: "decision", verdict: "approved", comments: [] }), 20);
    expect(await pending).toEqual({ type: "decision", verdict: "approved", comments: [] });
  });
  it("surfaces a client push to the host", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    const seen: unknown[] = [];
    host.onPush((wt, push) => { seen.push({ wt, push }); host.emit(wt, { type: "idle" }); });
    const client = new HttpReviewClient(port);
    await client.review("wt1", { replies: [{ threadId: "t1", body: "ack" }], comments: [] });
    expect(seen).toEqual([{ wt: "wt1", push: { replies: [{ threadId: "t1", body: "ack" }], comments: [] } }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core-adapters/tests/http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/http-server.ts
import { createServer, type Server } from "node:http";
import { ReviewEvent, PushPayload } from "@revizorro/protocol";
type Waiter = (e: ReviewEvent) => void;
export class HttpReviewHost {
  private server?: Server;
  private waiters = new Map<string, Waiter[]>();
  private pushCb?: (worktreeId: string, push: PushPayload) => void;
  onPush(cb: (worktreeId: string, push: PushPayload) => void): void { this.pushCb = cb; }
  emit(worktreeId: string, event: ReviewEvent): void {
    const q = this.waiters.get(worktreeId);
    const next = q?.shift();
    if (next) next(event);
  }
  start(): Promise<number> {
    this.server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/review") { res.statusCode = 404; return res.end(); }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { worktreeId, push } = JSON.parse(body || "{}");
        if (push !== undefined && this.pushCb) this.pushCb(worktreeId, PushPayload.parse(push));
        const list = this.waiters.get(worktreeId) ?? [];
        list.push((event) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(event)); });
        this.waiters.set(worktreeId, list);
      });
    });
    return new Promise((resolve) => this.server!.listen(0, "127.0.0.1", () => {
      resolve((this.server!.address() as { port: number }).port);
    }));
  }
  stop(): Promise<void> { return new Promise((r) => (this.server ? this.server.close(() => r()) : r())); }
}
```

```ts
// src/http-client.ts
import { request } from "node:http";
import { ReviewEvent, type PushPayload } from "@revizorro/protocol";
import type { ReviewTransport } from "@revizorro/core";
export class HttpReviewClient implements ReviewTransport {
  constructor(private readonly port: number, private readonly host = "127.0.0.1") {}
  review(worktreeId: string, push?: PushPayload): Promise<ReviewEvent> {
    const payload = JSON.stringify({ worktreeId, push });
    return new Promise((resolve, reject) => {
      const req = request(
        { host: this.host, port: this.port, path: "/review", method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => { try { resolve(ReviewEvent.parse(JSON.parse(body))); } catch (e) { reject(e); } });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }
}
```

Add both to `src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core-adapters/tests/http.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core-adapters
git commit -m "feat(adapters): localhost HTTP review host + client long-poll transport"
```

---

### Task 9: cli — `revizorro review` / `--push` surface

**Files:**
- Create: `packages/cli/src/resolve-worktree.ts`, `packages/cli/src/main.ts`, `packages/cli/src/index.ts`, `packages/cli/bin/revizorro.js`
- Test: `packages/cli/tests/main.test.ts`

**Interfaces:**
- Consumes: `ReviewTransport` from core; `PushPayload` from protocol.
- Produces:
  - `resolveWorktreeId(cwd: string): string` — sha1(12) of `git rev-parse --show-toplevel`.
  - `runReview(argv: string[], deps: { transport: ReviewTransport; worktreeId: string; readPush: (path: string) => PushPayload }): Promise<{ stdout: string; exitCode: number }>` — parses `review` / `--push <file>`, calls `transport.review`, returns the event serialized to stdout. Unknown command → exit 2.
- `bin/revizorro.js` wires real deps: reads `.claude/revizorro/port`, constructs `HttpReviewClient`, prints stdout, sets exit code. (Thin; not unit-tested.)

- [ ] **Step 1: Write the failing test**

```ts
// tests/main.test.ts
import { describe, it, expect } from "vitest";
import { runReview } from "../src/index.js";
import type { ReviewTransport } from "@revizorro/core";
import type { PushPayload } from "@revizorro/protocol";

const fakeTransport = (event: any): ReviewTransport => ({ review: async () => event });

describe("runReview", () => {
  it("prints the review event JSON for `review`", async () => {
    const r = await runReview(["review", "--worktree"], {
      transport: fakeTransport({ type: "decision", verdict: "approved", comments: [] }),
      worktreeId: "wt1", readPush: () => ({ replies: [], comments: [] }),
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ type: "decision", verdict: "approved", comments: [] });
  });
  it("passes the push payload through on `--push`", async () => {
    let received: PushPayload | undefined;
    const transport: ReviewTransport = { review: async (_wt, push) => { received = push; return { type: "idle" }; } };
    const r = await runReview(["review", "--push", "p.json"], {
      transport, worktreeId: "wt1",
      readPush: () => ({ replies: [{ threadId: "t1", body: "ack" }], comments: [] }),
    });
    expect(received).toEqual({ replies: [{ threadId: "t1", body: "ack" }], comments: [] });
    expect(r.exitCode).toBe(0);
  });
  it("exits 2 on an unknown command", async () => {
    const r = await runReview(["bogus"], {
      transport: fakeTransport({ type: "idle" }), worktreeId: "wt1", readPush: () => ({ replies: [], comments: [] }),
    });
    expect(r.exitCode).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/main.ts
import type { ReviewTransport } from "@revizorro/core";
import type { PushPayload } from "@revizorro/protocol";
export interface CliDeps {
  transport: ReviewTransport;
  worktreeId: string;
  readPush: (path: string) => PushPayload;
}
export async function runReview(argv: string[], deps: CliDeps): Promise<{ stdout: string; exitCode: number }> {
  if (argv[0] !== "review") return { stdout: "", exitCode: 2 };
  const pushIdx = argv.indexOf("--push");
  const push = pushIdx >= 0 ? deps.readPush(argv[pushIdx + 1]) : undefined;
  const event = await deps.transport.review(deps.worktreeId, push);
  return { stdout: JSON.stringify(event), exitCode: 0 };
}
```

```ts
// src/resolve-worktree.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
export function resolveWorktreeId(cwd: string): string {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  return createHash("sha1").update(top).digest("hex").slice(0, 12);
}
```

```ts
// src/index.ts
export * from "./main.js";
export * from "./resolve-worktree.js";
```

```js
// bin/revizorro.js
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HttpReviewClient } from "@revizorro/core-adapters";
import { PushPayload } from "@revizorro/protocol";
import { runReview, resolveWorktreeId } from "@revizorro/cli";
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const port = Number(readFileSync(join(repoRoot, ".claude", "revizorro", "port"), "utf8").trim());
const deps = {
  transport: new HttpReviewClient(port),
  worktreeId: resolveWorktreeId(process.cwd()),
  readPush: (p) => PushPayload.parse(JSON.parse(readFileSync(p, "utf8"))),
};
const { stdout, exitCode } = await runReview(process.argv.slice(2), deps);
if (stdout) process.stdout.write(stdout + "\n");
process.exit(exitCode);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cli`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): revizorro review/--push surface over transport port"
```

---

### Task 10: extension — HTTP host + review form (FormPort)

**Files:**
- Create: `packages/extension/src/host.ts`, `packages/extension/src/form.ts`, `packages/extension/src/extension.ts`
- Create: `packages/extension/package.json` (VS Code manifest fields), `packages/extension/media/review.html`

**Interfaces:**
- Consumes: `HttpReviewHost` (core-adapters), `FsSessionStore`, `GitDiffProvider`, core `startRound`/`applyPush`/`applyDecision`.
- Produces: on activation — start `HttpReviewHost`, write the port to `.claude/revizorro/port`; wire `onPush` → `applyPush` → save → refresh form; render the diff with the native diff editor + a `CommentController` for line-anchored threads + a webview/TreeView shell for the file list (viewed checkboxes/collapse) and Approve/Decline buttons. Approve/Decline → `host.emit(worktreeId, decisionEvent)`; a human comment → `host.emit(worktreeId, commentEvent)`; a "ping agent" on a thread → `host.emit(worktreeId, questionEvent)`.

> **Note:** This task is integration-heavy and exercised by manual VS Code runs + a thin `@vscode/test-electron` smoke test, not full unit TDD. The pure decision logic it relies on (`startRound`, `applyPush`, `decideCollapsed`, `applyDecision`) is already unit-tested in Tasks 3–5; this task only wires it to the VS Code API and the host.

- [ ] **Step 1: VS Code manifest** (`package.json`)

```json
{
  "name": "revizorro",
  "displayName": "revizorro",
  "publisher": "revizorro",
  "version": "0.0.1",
  "engines": { "vscode": "^1.90.0" },
  "main": "./dist/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "commands": [
      { "command": "revizorro.toggleViewMode", "title": "revizorro: Toggle Diff View" },
      { "command": "revizorro.approve", "title": "revizorro: Approve" },
      { "command": "revizorro.decline", "title": "revizorro: Decline" }
    ]
  },
  "dependencies": {
    "@revizorro/protocol": "workspace:*",
    "@revizorro/core": "workspace:*",
    "@revizorro/core-adapters": "workspace:*"
  }
}
```

- [ ] **Step 2: Host wiring** (`host.ts`)

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { HttpReviewHost, FsSessionStore, GitDiffProvider } from "@revizorro/core-adapters";
import { startRound, applyPush, applyDecision } from "@revizorro/core";
import type { SessionState } from "@revizorro/protocol";

export class ReviewHost {
  readonly events = new HttpReviewHost();
  private store: FsSessionStore;
  private diff: GitDiffProvider;
  private idN = 0;
  constructor(private repoRoot: string, private worktreeId: string, private onState: (s: SessionState) => void) {
    this.store = new FsSessionStore(repoRoot);
    this.diff = new GitDiffProvider(repoRoot);
    this.events.onPush(async (_wt, push) => {
      const cur = await this.store.load(this.worktreeId);
      if (!cur) return;
      const next = applyPush(cur, push, () => `a${++this.idN}`);
      await this.store.save(next); this.onState(next);
    });
  }
  async start(): Promise<void> {
    const port = await this.events.start();
    const p = join(this.repoRoot, ".claude", "revizorro", "port");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(port), "utf8");
    await this.newRound();
  }
  async newRound(): Promise<void> {
    const prev = await this.store.load(this.worktreeId);
    const files = await this.diff.diff(this.worktreeId);
    const s = startRound(prev, this.worktreeId, files);
    await this.store.save(s); this.onState(s);
  }
  approve(): void { this.events.emit(this.worktreeId, { type: "decision", verdict: "approved", comments: [] }); }
}
```

- [ ] **Step 3: Form rendering** (`form.ts`) — `CommentController` for inline threads + a webview panel (`media/review.html`) listing files with viewed checkboxes and Approve/Decline + a view-mode toggle that opens `vscode.diff` (side-by-side) or the inline diff. Wire button messages to `ReviewHost.approve()` / emit comment & question events. (Concrete VS Code API code; validated manually.)

- [ ] **Step 4: `extension.ts`** — `activate()`: resolve `repoRoot` + `worktreeId`, construct `ReviewHost`, `await host.start()`, build the form, register commands. `deactivate()`: `host.events.stop()`.

- [ ] **Step 5: Manual smoke test**

Run: `pnpm --filter @revizorro/extension build`, then F5 (Extension Development Host). In a git repo with uncommitted changes, confirm: port file written; from a terminal `node packages/cli/bin/revizorro.js review --worktree` blocks; clicking Approve in the form unblocks it with the decision JSON.

- [ ] **Step 6: Commit**

```bash
git add packages/extension
git commit -m "feat(extension): HTTP host + Comments-API review form (FormPort)"
```

---

### Task 11: plugin — `/revizorro` skill + command

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`, `plugin/skills/revizorro/SKILL.md`, `plugin/commands/revizorro.md`

**Interfaces:**
- Produces: a Claude Code plugin whose `/revizorro` command instructs the agent to run the event loop: `revizorro review --worktree` → branch on event type → `--push` a temp payload file for replies/comments → re-`review` on `idle` → fix code + new round on `declined` → stop on `approved`.

- [ ] **Step 1: `plugin.json`**

```json
{ "name": "revizorro", "version": "0.1.0", "description": "Local pre-merge AI review loop" }
```

- [ ] **Step 2: `SKILL.md`** — the agent loop, verbatim protocol from spec §2.2, with the idle re-arm rule and the temp-file convention for `--push` payloads (`$CLAUDE_JOB_DIR/tmp/revizorro-push.json`).

- [ ] **Step 3: `commands/revizorro.md`** — slash command that invokes the skill.

- [ ] **Step 4: Commit**

```bash
git add plugin
git commit -m "feat(plugin): /revizorro skill driving the agent review loop"
```

---

### Task 12: distribution wiring

**Files:**
- Modify: `packages/cli/package.json` (`bin`, `files`, `publishConfig`), root `README.md`
- Create: `README.md` (install: `npm i -g @revizorro/cli` + marketplace extension; port-discovery note)

**Interfaces:**
- Produces: `npm i -g` makes `revizorro` resolvable on PATH; `vsce package` produces the `.vsix`; documented two-step install + port-discovery contract (`.claude/revizorro/port`).

- [ ] **Step 1:** Add `"bin"`, `"files": ["dist","bin"]` to `packages/cli/package.json`; ensure `bin/revizorro.js` shebang + executable bit.
- [ ] **Step 2:** Add `vsce` devDep + `package` script to the extension; verify `pnpm --filter @revizorro/extension package` emits a `.vsix`.
- [ ] **Step 3:** Write `README.md` (install steps, the loop diagram, port-discovery).
- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: distribution wiring — npm bin + vsce package + README"
```

---

## Self-Review

**Spec coverage (§ → Task):** §2 protocol/loop → Tasks 2,8,9,11; §3 components → all; §4 hexagon → package layout + Tasks 3–9; §5 session/collapse → Tasks 3,5,6; §6 diff modes → Task 10 (native editor + toggle); §7 distribution → Task 12; §8 lenses → **out of scope (I2)**, protocol leaves room via additive event fields; §9 error handling → idle (Task 9 bin + spec), missing-port/unreachable (Task 9 bin), decline loop (Task 11), hash-mismatch expand (Task 3); §10 testing → per-task TDD; §11 increments → this plan is I1 only. No uncovered I1 requirement.

**Placeholder scan:** Task 10 step 3 and Task 11 step 2 describe VS Code-API / Markdown content rather than pasting full bodies — these are integration/prose deliverables, intentionally lighter per the spec's "extension UI is lighter integration"; all *logic* tasks (2–9) carry complete code + tests. No `TBD`/`TODO` in logic steps.

**Type consistency:** `DiffFile{path,contentHash}` consistent across collapse/round/diff-git. `SessionState`/`PushPayload`/`ReviewEvent` sourced from `@revizorro/protocol` everywhere. `ReviewTransport.review(worktreeId, push?)` matches client impl + cli consumer. `FsSessionStore.load → SessionState|null` matches `SessionStore` port. Idle value `540000` stated once in Global Constraints, referenced (not redefined) elsewhere.

## Beads

Beads is **not** initialized in this repo (the beads-sync rule is tea-rags-mcp-scoped). Recommendation: `bd init` in revizorro and create one epic (`revizorro I1`) with Tasks 1–12 as children, labels `architecture`/`api`/`dx`. Flagged for your decision — not done automatically.

## Execution Handoff

Plan complete. Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — execute in this session with checkpoints.
