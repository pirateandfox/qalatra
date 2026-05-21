# Codebase Verification Readiness Audit

_Conducted 2026-05-18. Based on direct codebase inspection._

---

## 1. Verification Readiness Score

### Modularity and Boundary Clarity — 6/10
File roles are clearly defined and documented in CLAUDE.md/AGENTS.md. The MCP `tools/` layer is properly decomposed. However, four core files are monolithic with no internal sub-module structure: `db-worker.js` (944 lines), `ipc-handlers.js` (749 lines), `mcp/tools/tasks.js` (728 lines), and `electron-main.js` (570 lines). An AI review tool can identify the boundaries between files but will find it difficult to reason about data flows within these files because there are no enforced seams.
> **What a 10 looks like:** Each of the four large files is decomposed into focused sub-modules (e.g., `db-worker/tasks.js`, `db-worker/recurrence.js`) with explicit import surfaces. An AI tool can analyze a single module without holding the full file context.

### Test Coverage and Test Quality — 1/10
Zero automated tests exist — no unit tests, integration tests, or property-based tests of any kind. The only verification is TypeScript compilation (UI only) and build success. An AI adversarial tool has no behavioral oracle: it can identify a suspected logic bug in recurrence or IPC handling but cannot confirm whether it manifests, and any proposed fix is unverifiable without running the app manually.
> **What a 10 looks like:** A Vitest suite covers all MCP tool functions, recurrence logic, and DB migrations against an in-memory SQLite; CI runs it on every push and blocks merge on failure.

### Documentation and Explicitness — 6/10
CLAUDE.md and AGENTS.md are unusually complete for a personal project: architecture, key invariants, gotchas, and build instructions are documented. However, the authorization model is unstated (implicit local-trust), data flows between the Electron main/renderer/MCP layers are not diagrammed, and the v2 architecture doc (`plan/ARCHITECTURE.md`) describes a future state that does not yet exist — which creates ambiguity about what is implemented vs. aspirational.
> **What a 10 looks like:** A data flow diagram showing exactly how a task created in the UI travels through IPC → db-worker → SQLite, and separately through MCP → db.js → SQLite, with trust boundaries explicitly labeled.

### Dependency Health and Supply Chain Legibility — 4/10
26 direct dependencies across root and UI. Two packages are pinned to `latest` with no version lock (`@modelcontextprotocol/sdk: latest`, `uuid: latest`). The npm audit shows 25 vulnerabilities in the root (15 high) and 6 in the UI (3 high) — none critical, but they include active CVEs in DOMPurify (the HTML sanitization library actually used in production) and Vite (dev server). No dependency audit step in CI.
> **What a 10 looks like:** All deps pinned to exact versions in package-lock.json, `npm audit --audit-level=high` runs in CI and fails on high/critical, and `latest` pins are replaced with explicit semver ranges.

### Tribal Knowledge Risk (inverse — higher = less tribal knowledge) — 7/10
The documented gotchas (sort_order ordering, surface_after on recurring tasks, Electron ABI requirements, MCP port management) are captured in CLAUDE.md, meaning a new developer or AI tool can orient without asking anyone. The main residual tribal knowledge is the recurrence logic edge cases — the CLAUDE.md mentions the invariant but not why it was broken or what the exact failure mode was.
> **What a 10 looks like:** Each documented invariant in CLAUDE.md has a corresponding failing test that would have caught the original bug — making the invariant machine-verifiable, not just human-readable.

### Security Model Explicitness — 7/10
For a personal single-user local tool, the security model is simple and appropriate: full local process trust, no authentication on the MCP server (intentional — localhost only), no multi-user data separation needed. This model is implicitly documented through the architecture. The only external exposure is S3/R2 (standard AWS SDK) and GitHub releases (signing + notarization). Given the low sensitivity, the implicit model is honest rather than evasive.
> **What a 10 looks like:** A one-page threat model doc that explicitly states the trust boundary ("anyone who can run the Electron app has full DB access — this is intentional and correct for a single-user local tool"), documents what happens if the MCP port is externally reachable, and tracks the DOMPurify CVEs with a remediation decision.

### Composite Weighted Score
Weights adjusted for low security sensitivity (personal tool, no PII or payments):

| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Modularity & Boundary Clarity | 6 | 15% | 0.90 |
| Test Coverage & Quality | 1 | 30% | 0.30 |
| Documentation & Explicitness | 6 | 20% | 1.20 |
| Dependency Health | 4 | 15% | 0.60 |
| Tribal Knowledge Risk | 7 | 10% | 0.70 |
| Security Model Explicitness | 7 | 10% | 0.70 |
| **Composite** | | | **4.4 / 10** |

---

## 2. Structural Blockers

### 1. Zero test suite
**Severity: Critical**

There are no automated tests of any kind. An AI adversarial review tool can identify suspicious patterns — ambiguous data flows, potential null dereferences, recurrence edge cases — but has no way to confirm whether those patterns represent real bugs in this specific codebase, or to verify that a proposed fix doesn't break something else. Without a behavioral oracle, machine-scale review degrades to static pattern matching: high false-positive rate, no exploitability confirmation, and no regression safety net for fixes.

### 2. MCP backend in untyped JavaScript
**Severity: High**

`mcp/db.js`, `mcp/tools/tasks.js`, `db-worker.js`, and `ipc-handlers.js` — together ~3,200 lines and the most logic-heavy code in the repo — have zero type annotations. AI review tools use type information to trace how untrusted input travels through the system, identify type confusion, and reason about what values are possible at each call site. In untyped JS, this analysis relies entirely on inference, which misses narrowing, fails on dynamic property access (`args[field]`), and produces noisy results on the dynamic SQL construction in `tasks.js`.

### 3. Two `latest`-pinned dependencies
**Severity: Medium**

`@modelcontextprotocol/sdk: latest` and `uuid: latest` mean the installed version is not fixed at review time and can silently change between installs. An AI review tool analyzing `node_modules` may be reviewing different code than what shipped in the last build. For `@modelcontextprotocol/sdk` specifically — a package that handles all inbound MCP requests — this is the highest-value dependency to pin exactly.

### 4. Unpatched DOMPurify CVEs
**Severity: Medium**

The current pinned version of DOMPurify (`<=3.3.3`) has four known CVEs: two FORBID_TAGS bypasses, a SAFE_FOR_TEMPLATES bypass in RETURN_DOM mode, and a prototype pollution → XSS via CUSTOM_ELEMENT_HANDLING. DOMPurify is actively used in the codebase to sanitize `marked()` HTML output before rendering. An AI adversarial tool will flag this correctly — but more importantly, these are real bypasses, not theoretical ones. `npm audit fix` resolves them.

### 5. No quality gate in CI beyond build
**Severity: Medium**

ESLint is configured for the UI but not run in CI. The `npm audit` command is never run in CI. An AI review tool operating on this repo cannot assume that the code it sees is even ESLint-clean, and findings it generates (e.g., unsafe TypeScript patterns, unused variables that might indicate dead code paths) have no CI enforcement mechanism to prevent them from being reintroduced after remediation.

### 6. Large monolithic files with no internal structure
**Severity: Medium**

`db-worker.js` (944 lines) and `ipc-handlers.js` (749 lines) are flat files with no internal exports or module boundaries. All IPC operations live in a single scope with shared closure state. An AI review tool processing these files must hold the entire file as context to reason about any single function — increasing noise and reducing confidence in cross-function data flow analysis. This is particularly acute for the dynamic SQL construction in `tasks.js`, where the allowlist check and the clause-building loop are separated by ~30 lines.

---

## 3. Prioritized Refactor Plan

### Q2 (Do Now)

**1. Add `npm audit` and ESLint to CI**
- Run `npm audit --audit-level=high` and `npm audit --audit-level=high --prefix ui` as CI steps. Add `npm run lint --prefix ui` before build.
- **Effort:** 0.5 days
- **Unblocks:** Blocker 5 (no CI quality gate). Also immediately surfaces the DOMPurify CVEs as a blocking CI failure.
- **Owner:** Justin / Claude Code

**2. Patch DOMPurify and pin `latest` dependencies**
- Run `npm audit fix` in both root and `ui/`. Replace `"@modelcontextprotocol/sdk": "latest"` and `"uuid": "latest"` with the currently installed exact versions (check `package-lock.json`).
- **Effort:** 0.5 days (mostly validation that nothing breaks)
- **Unblocks:** Blocker 3 (floating deps), Blocker 4 (DOMPurify CVEs)
- **Owner:** Justin / Claude Code

**3. Add Vitest and a first test fixture**
- Add `vitest` to root `package.json`. Create `test/fixtures/db.js` (in-memory SQLite + `migrate()`). Write the recurrence edge case tests and recurring task spawn tests from `EVAL_QUALITY_PLAN.md`.
- **Effort:** 2–3 days
- **Unblocks:** Blocker 1 (zero test suite) — first increment. Also makes the MCP tool logic testable, which is a prerequisite for AI adversarial confirmation of findings.
- **Owner:** Justin / Claude Code

### Q2–Q3

**4. Add `// @ts-check` and JSDoc types to `mcp/db.js` and `mcp/tools/tasks.js`**
- Start with the two largest and most logic-dense plain-JS files. Add `@param`/`@returns` JSDoc and run `tsc --checkJs --noEmit` against `mcp/`. Fix any reported type errors.
- **Effort:** 3–5 days
- **Unblocks:** Blocker 2 (untyped backend). Doesn't require a full TypeScript migration.
- **Owner:** Justin / Claude Code

**5. Decompose `db-worker.js` into sub-modules**
- Extract task operations, recurrence logic, and heartbeat/habit operations into separate files imported by `db-worker.js`. The public interface (IPC message dispatch) stays in the main file.
- **Effort:** 3–4 days
- **Unblocks:** Blocker 6 (monolithic files). Also a prerequisite for meaningful unit testing of individual operations.
- **Owner:** Justin

### Q3

**6. Write a one-page explicit threat model**
- Create `plan/THREAT_MODEL.md`. State the trust boundary ("local process = full access, intentional"), document the MCP server's localhost-only contract, track the CVE remediation decisions, and note what would need to change if the app ever gets multi-user or remote-access features.
- **Effort:** 1 day
- **Unblocks:** Documentation ambiguity (v2 ARCHITECTURE.md vs. current state). Makes the implicit security model explicit and machine-readable.
- **Owner:** Justin

---

## 4. Risk Summary for Leadership

Qalatra is a personal tool with no external users, no PII beyond Justin's own task data, and no network exposure beyond localhost. The honest answer to "Are we ready for AI adversarial review?" is: not quite — but the gap is smaller and less urgent than it would be for a production system.

The most concrete risk today is not a security breach. It's silent logic regression — specifically in recurrence and IPC handling — that AI-generated code can introduce faster than manual review can catch. The zero-test baseline means that when an AI adversarial tool identifies a suspected bug, there is no behavioral oracle to confirm it, and no regression harness to verify a fix. For a personal tool this is acceptable; for any future version that handles other users' data or runs as a networked service, it would be a serious liability.

The dependency situation deserves attention this week regardless of readiness goals. DOMPurify has four active CVEs in its currently pinned version and is used for HTML sanitization in production code. This is a concrete, fixable issue — `npm audit fix` resolves it in under an hour. The two `latest`-pinned packages (`@modelcontextprotocol/sdk`, `uuid`) represent a small but real supply chain risk and should be replaced with pinned versions.

To get to a "ready for continuous AI adversarial review" state, the critical path is: (1) add a test suite with at least the recurrence and spawn-correctness tests, (2) add type coverage to the MCP backend, and (3) run lint and audit in CI. Given that Claude Code is the primary author of this codebase, these aren't just quality improvements — they're the feedback loops that let the AI author know when it's broken something. Without them, each autonomous coding session operates without a safety net.

---

## 5. What "Good" Looks Like

A fully verification-ready Qalatra would have three properties an AI adversarial tool can exploit immediately:

**Behavioral oracles exist.** A Vitest suite covers all MCP tool functions against an in-memory SQLite fixture. When an AI tool hypothesizes "this recurrence case produces the wrong date," it can run a test to confirm. When it suggests a fix, CI confirms the fix doesn't regress anything else.

**Types trace data flows.** The entire codebase — including `mcp/db.js`, `mcp/tools/*.js`, `db-worker.js`, and `ipc-handlers.js` — has type annotations. When an AI tool asks "what type arrives at this SQL parameter?", it can trace from the IPC call site through the handler through the db function to the query, without inference gaps.

**The dependency surface is audited and pinned.** Every dependency has an exact version in the lockfile. `npm audit --audit-level=high` runs in CI and fails on any unpatched high-severity CVE. The security posture of the dependency tree is visible at a glance, not discovered on demand.

In that state, running an AI adversarial review tool against this codebase would produce a high-signal, low-noise report focused on actual logic bugs and data-flow issues — not drowned out by type inference failures, missing behavioral context, and dep-audit noise.

---

_See also: `plan/EVAL_QUALITY_PLAN.md` — complements this audit with a specific list of missing code-quality evals and implementation sequence._
