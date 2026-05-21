# Eval Quality Plan

_Generated 2026-05-18 via Nate's Substack eval-quality-diagnostic prompt._

---

## 1. Current Ratio Diagnosis

**~98/2 functional-to-quality — but there are essentially zero functional tests either.**

The ratio framing breaks down here: qalatra has almost no automated evals of any kind. What exists:

| Check | What it catches | Category |
|---|---|---|
| `tsc -b` (part of `build`) | Type errors in UI | Quality (partial) |
| ESLint (local only, not in CI) | Hooks rules, unused vars | Quality (partial) |
| `check-imports.mjs` | Missing Electron bundle files | Structural/deploy |
| Build success | Syntax errors, missing deps | Structural |

There are **no unit tests, no integration tests, no functional tests of any kind** for the MCP tools, recurrence logic, IPC handlers, database migrations, or UI components.

For a personal tool this isn't catastrophic — but it means Claude Code, which writes the majority of the code autonomously, has no feedback signal beyond "it compiled." The specific failure modes this creates: silent logic regressions in recurrence, MCP tool schemas drifting from implementations, and database migrations silently failing on edge cases.

---

## 2. What You're Catching vs. What You're Missing

| Currently caught | Currently missed |
|---|---|
| TypeScript type errors in `ui/src/` | Any logic error in `mcp/tools/` (plain JS, zero type checking) |
| Unused variables/parameters in UI | Recurrence edge cases (month-end, DST, BYMONTHDAY=31) |
| React hooks rule violations | MCP tool `inputSchema` properties drifting from actual `args.X` usage |
| Missing Electron bundle files | IPC handler args passed raw to db-worker with no shape validation |
| Build-breaking syntax errors | `any` propagation (50+ uses in UI, no `no-unsafe-*` rules) |
| (locally) Basic ESLint style issues | Database migration idempotency failures |
| | Recurring task spawn correctness (no `surface_after` set, correct `due_date`) |
| | Dynamic SQL field allowlist drift in `update_task` |
| | MCP tool error response format inconsistency |
| | ESLint violations shipping (lint not in CI) |

---

## 3. The Missing Code-Quality Evals

### 1. Recurrence Logic Unit Tests
**Priority: High**

- **What it checks:** `nextRecurrenceDate` produces correct dates for all RRULE patterns, especially month-end edge cases (`BYMONTHDAY=31` in a 30-day month, February), and that `FREQ=WEEKLY;BYDAY=MO,WE,FR` advances correctly across week boundaries.
- **Why it matters for AI code:** Claude reliably gets the happy path right and silently fails on calendar edge cases — particularly DST transitions, month-end clamping, and timezone-naive date arithmetic. These bugs are invisible without explicit regression tests.
- **How to implement:** Add Vitest to the root package (or the `mcp/` layer). Write ~15 cases against `nextRecurrenceDate` in `mcp/db.js`: one per RRULE variant you use, plus `BYMONTHDAY=31` in April, `BYMONTHDAY=29` in a non-leap February, and the "complete on the same day as due" case. Run with `vitest run`.

---

### 2. MCP Tool Schema/Implementation Drift
**Priority: High**

- **What it checks:** Every `args.X` reference inside each MCP tool has a corresponding property declared in `inputSchema`, and vice versa — no undeclared args being used, no schema properties that are never read.
- **Why it matters for AI code:** When Claude adds a new parameter to a tool, it reliably updates either the schema or the implementation but not always both. The result is tools that silently ignore parameters or expose undocumented ones. This is the most common category of Claude Code drift in this codebase.
- **How to implement:** A custom Node script (can live in `scripts/`) that parses each tool file with regex: extract all `args\.(\w+)` references and all `properties` keys from `inputSchema`, then diff them. Run in CI. ~50 lines of code.

---

### 3. CI Lint Gate
**Priority: High**

- **What it checks:** ESLint runs on every push, not just locally.
- **Why it matters for AI code:** Claude Code never runs `npm run lint` unless you ask it to. ESLint catches real issues (`react-hooks/exhaustive-deps` violations, unsafe TypeScript patterns) that the build doesn't catch. Right now they accumulate silently.
- **How to implement:** Add a step to `.github/workflows/release.yml` (or a separate `ci.yml` for non-release pushes): `npm run lint --prefix ui`. Two lines. Also consider running it pre-commit via a git hook (ask Claude Code to add a `prepare` script that installs husky).

---

### 4. Recurring Task Spawn Correctness
**Priority: High**

- **What it checks:** After `completeTask` or `skipTask` on a recurring task, the spawned child task has: (a) correct `due_date` per the RRULE, (b) `surface_after` is null/unset, (c) `status = 'active'`, (d) same `recurrence` value as parent.
- **Why it matters for AI code:** The CLAUDE.md rule "never set `surface_after` on recurring tasks" exists because it was broken before. That invariant is documented but not tested — meaning it will break again the next time Claude modifies the recurrence spawn path.
- **How to implement:** Vitest unit test: create a recurring task in an in-memory SQLite DB, call `completeTask`, assert on the spawned row. The `mcp/db.js` functions can be imported directly.

---

### 5. TypeScript `any` Boundary Enforcement
**Priority: Medium**

- **What it checks:** No `any` escapes from the IPC boundary into typed UI components; the 50+ current `any` uses are not growing.
- **Why it matters for AI code:** Claude uses `any` as a shortcut when it's uncertain about a type, especially at IPC boundaries and API response shapes. Once `any` infects a type, TypeScript stops protecting the entire downstream call chain. The current `tsconfig.app.json` has `strict: true` but doesn't enable `@typescript-eslint/no-explicit-any` or `no-unsafe-*`.
- **How to implement:** Add to `ui/eslint.config.js`:
  ```js
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-unsafe-assignment': 'warn',
  '@typescript-eslint/no-unsafe-member-access': 'warn',
  ```
  Run lint, fix the existing violations (most are at `api.ts` IPC boundary — define proper response types), then promote to `'error'`.

---

### 6. MCP Plain-JS Type Coverage
**Priority: Medium**

- **What it checks:** `mcp/tools/*.js` and `mcp/db.js` — the largest, most logic-heavy part of the codebase — have zero TypeScript coverage. Adds JSDoc `@param`/`@returns` types + `tsc --checkJs`.
- **Why it matters for AI code:** Claude writes MCP tools in plain JS because that's how the first ones were written. The entire task CRUD, recurrence, briefing, and triage logic lives here with no type safety. Wrong field names, wrong return shapes, passing strings where integers are expected — none of this is caught.
- **How to implement:** Two options: (a) Add `// @ts-check` to each MCP file + JSDoc types + run `tsc --checkJs --noEmit` against `mcp/`; or (b) convert `mcp/` to TypeScript. Start with (a): it's a one-day task and catches the highest-value bugs without a full migration.

---

### 7. Database Migration Idempotency
**Priority: Medium**

- **What it checks:** Running `migrate()` twice on the same database produces no errors and leaves the schema identical to a single run.
- **Why it matters for AI code:** The migrations use `ALTER TABLE ... ADD COLUMN` in try/catch. Claude occasionally adds a migration that works on a fresh DB but throws on upgrade (wrong column name, duplicate migration, missing table). Without a test, this surfaces only when a user upgrades.
- **How to implement:** Vitest test: open an in-memory SQLite, call `migrate()` once, call it again, assert no throw and that all expected columns exist. Import `mcp/db.js` directly.

---

### 8. Dynamic SQL Field Allowlist
**Priority: Medium**

- **What it checks:** The `update_task` tool builds `UPDATE tasks SET ${setClauses.join(', ')}` from a list of permitted fields. This check verifies that only fields in the explicit allowlist can appear in the generated SQL — passing an unexpected field name throws rather than being silently ignored or interpolated.
- **Why it matters for AI code:** When Claude extends `update_task` to support new fields, it sometimes adds the field to the SQL construction without adding it to the allowlist check, or vice versa. The current code is correct, but it's untested, and the pattern is easy to break.
- **How to implement:** Unit test: call the update logic with a body containing `{ task_id: 1, __proto__: 'x', nonExistentField: 'y' }` and assert either (a) the field is dropped or (b) an error is thrown. Also test that each allowlisted field does appear in the generated SQL when provided.

---

### 9. MCP Tool Error Response Consistency
**Priority: Medium**

- **What it checks:** When a tool receives bad input or encounters a DB error, it returns a structured error response rather than throwing an unhandled exception that kills the MCP session.
- **Why it matters for AI code:** Claude-generated MCP tools inconsistently handle errors — some throw, some return `{error: 'message'}`, some return empty results silently. This causes confusing behavior when tools fail mid-session.
- **How to implement:** For each tool in `mcp/tools/`, write a test that passes invalid args (missing required field, nonexistent task ID) and asserts the response shape is consistent: `{ content: [{ type: 'text', text: ... }], isError: true }`.

---

### 10. `sort_order` Uniqueness Invariant
**Priority: Low**

- **What it checks:** After any reordering operation, active tasks in a context have unique, non-null `sort_order` values — no two tasks share the same position.
- **Why it matters for AI code:** Sort order is the primary display ordering mechanism. Claude occasionally writes reorder logic that works for the specified task but creates collisions for adjacent tasks, producing a non-deterministic display order.
- **How to implement:** A reusable assertion helper: `assertSortOrderUnique(db, context)` — runs `SELECT sort_order, COUNT(*) FROM tasks WHERE status='active' AND context=? GROUP BY sort_order HAVING COUNT(*)>1` and asserts empty. Call it at the end of any test that touches `sort_order`.

---

### 11. DOMPurify Sanitization Coverage
**Priority: Low**

- **What it checks:** All HTML rendered from `marked()` output goes through `DOMPurify.sanitize()` before being set as `innerHTML`. No raw `marked()` output reaches the DOM.
- **Why it matters for AI code:** Claude reliably includes `DOMPurify` when asked but will skip it when adding new rendering paths (e.g., email preview, daily notes). `EmailPreview.tsx` is worth auditing now.
- **How to implement:** Grep in CI: `grep -r 'marked(' ui/src/ | grep -v DOMPurify` — fail if any match. Alternatively, a custom `no-restricted-syntax` ESLint rule covering `dangerouslySetInnerHTML` without a `DOMPurify.sanitize` wrapper.

---

## 4. Recommended Target Ratio

**60/40 functional-to-quality.**

Qalatra is a personal productivity tool — no external attack surface, no multi-user data model, no financial transactions. The dominant failure mode is **silent logic regressions**: broken recurrence, wrong task counts in briefings, MCP tools that appear to work but return stale data. That makes behavioral correctness of the business logic layer (items 1, 4, 7, 8) the highest-value investment, not architectural purity or security hardening.

Given the starting point of near-zero, the first goal is simply to have tests at all. The ratio matters less than establishing the habit and harness.

---

## 5. Implementation Sequence

### Week 1 — Foundation

1. **Add ESLint to CI.** Add a lint step to `.github/workflows/release.yml` (or a new `ci.yml`): `npm run lint --prefix ui`. Two lines. Fixes the "lint never runs" gap immediately.
2. **Add Vitest + first test.** `pnpm add -D vitest` at root. Write recurrence edge case tests for `nextRecurrenceDate` in `mcp/db.js`. Establishes the harness and is the highest-value single test in the repo.

### Week 2 — Highest-Risk Gaps

3. **Recurring task spawn correctness test** (eval 4). Directly tests the invariant documented in CLAUDE.md — protects the `surface_after` rule from the next agentic session.
4. **MCP schema drift script** (eval 2). ~50 lines, runs in CI, catches the most common category of Claude Code mistakes in this repo.

### This Quarter — Depth

5. Enable `@typescript-eslint/no-explicit-any` as `warn`, fix existing violations, promote to `error`.
6. Add `// @ts-check` + JSDoc types to `mcp/db.js` and `mcp/tools/tasks.js` (the two largest files).
7. Database migration idempotency test.
8. Dynamic SQL allowlist test.

### When the Above Are Solid — Polish

9. MCP tool error response consistency tests.
10. DOMPurify grep in CI.
11. `sort_order` uniqueness assertions wired into future reorder tests.

---

## Standing Up the Harness

Don't over-engineer it. `vitest` with a shared `mcp/db.js` fixture that opens an in-memory SQLite (`new Database(':memory:')`, calls `migrate()`) is all you need. The MCP tools are plain functions — they import `db` and can be tested by substituting the in-memory instance. No mocking framework needed; the real SQLite running in-memory is fast and faithful.

```js
// test/fixtures/db.js
import Database from 'better-sqlite3'
import { migrate, setDb } from '../mcp/db.js'

export function createTestDb() {
  const db = new Database(':memory:')
  migrate(db)
  setDb(db)
  return db
}
```

_(This assumes `mcp/db.js` is refactored to accept a db instance via `setDb()` rather than opening its own — a small, safe change that makes the whole layer testable.)_
