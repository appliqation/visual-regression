# CLAUDE.md — appliqation-visual-regression

Part of the Appliqation workspace. See `~/Sites/localhost/CLAUDE.md` for how the
product fits together; this file is the map of **this repo only**.

## What this repo is

A standalone agent that checks ONE route for a real visual regression by diffing it
against its own live production counterpart. Not a stored-baseline tool — production is
fetched live at comparison time, which eliminates the baseline-staleness/manual-approval
maintenance burden that kills most visual-regression setups in practice. Seventh
consumer of `@appliqation/agent-core` (`~/Sites/localhost/appliqation-agent-core/`);
read that repo's `CLAUDE.md` first for the shared engine this is built from.

**Built to close a real functional-testing gap**: nothing else in this family checks
appearance, only behaviour — a `getByRole` assertion can pass while the page is visibly
broken. Discussed and scoped in the same session that built `appliqation-heal-selector`
and `appliqation-autopilot`'s scenario/test-set mode; see that discussion for why
production-as-baseline was chosen over a stored-baseline or design-mock comparison.

## The one rule that matters more than the mechanism

**If the route doesn't exist on production, that's not a failure — it's not
applicable.** Same "decline is a legitimate outcome" discipline `heal-selector` already
uses, extended here: no production equivalent means no comparison, ever, not a fallback
to a design file or any other stand-in baseline. `captureAndDiff.ts`'s `capture_and_diff`
tool makes this determination itself (a real HTTP 404 check), and the policy prompt
explicitly forbids the model from overriding it — `not-applicable` is never a judgment
call in Phase 3, only ever something Phase 2's tool result pre-decided.

The second discipline, equally load-bearing: **the mechanical pipeline is entirely
code-owned, never something the model claims.** Unlike every other agent in this family,
this one never exposes `BROWSER_TOOL_DEFS` to the model at all — navigation, masking,
screenshotting, and pixel-diffing all happen inside one atomic `capture_and_diff` call
the orchestrator dispatches directly to `CaptureAndDiffTool`, not something the model
drives turn-by-turn. The model's only real work is judgment, and even that isn't trusted
as free-text prose — it's captured through a second tool, `submit_verdict`, with a
structured schema (`verdict` enum, `primary_finding`, `secondary_findings`), same
discipline `appq:autotest-validator` already uses for writing its own verdict via a real
tool call's arguments rather than asserting it in prose.

## No appq-served prompt exists for this (unlike scriptgen/defect-fix/explorer)

Genuinely new methodology, no server-side equivalent yet — same reasoning
`appliqation-heal-selector` already documents for itself. `src/policy/visualRegressionPrompt.ts`
is local and bundled, driven through `@appliqation/agent-core`'s `runLoop()` directly.

## Deliberately narrow tool surface — the opposite composition from heal-selector

`heal-selector` combines browser tools + coding tools + appq context in one `runLoop()`
session because it genuinely needs the model to drive live diagnosis (navigate, inspect,
decide). This agent needs none of that: the entire mechanical pipeline has no decision
points a model should make, so it's one deterministic, code-owned tool
(`src/tools/captureAndDiff.ts`'s `capture_and_diff`) plus one structured-output tool
(`src/tools/verdictTool.ts`'s `submit_verdict`) plus optional read-only appq context
(`get_scenario`). `src/orchestrator/visualRegression.ts`'s tool palette is
`[...appqToolDefs, ...CAPTURE_TOOL_DEFS, SUBMIT_VERDICT_TOOL_DEF]` — no
`BROWSER_TOOL_DEFS` at all, on purpose.

## Never trust the model's own claim, applied to a domain with no objective code signal

Every sibling agent's "never trust the model" discipline maps onto a real code signal
(`heal-selector`'s `lastPlaywrightTestRun()` exit code, `run_generate`'s `testRun.ok`).
A visual-regression *verdict* has no such objective equivalent — "is this a real
regression" is inherently a judgment call, not something code can compute. The
discipline here is narrower but still real: the **diff statistics** the verdict is
judged from (`diffPixelCount`/`diffPercentage`) are always real and code-computed
(`captureAndDiff.ts`'s `pixelmatch` call), and the policy instructs the model to cite
them, never restate a different number. The verdict *classification* itself is
necessarily the model's judgment — captured as structured tool-call arguments
(`submit_verdict`), not parsed out of report prose, so at least the *shape* of the
judgment is machine-reliable even though the judgment's *content* can't be independently
re-verified the way a real test-run exit code can.

**`not-applicable` is the one verdict value that IS code-decided**, not model-judged —
see `captureAndDiff.ts`'s 404 short-circuit, which returns a pre-formatted
`VERDICT: not-applicable (predetermined...)` string the policy prompt explicitly tells
the model never to override.

**Known limitation, confirmed live against DailyPulse**: the 404 short-circuit is
HTTP-status-based only. A client-routed SPA (DailyPulse included) commonly serves its
own "not found" page at HTTP 200 — the server has no idea the route is invalid, only the
client-side router does — so this short-circuit never fires for that class of app, and
Phase 3's judgment is reached instead. Live-verified this degrades safely rather than
producing a false regression: given an actually-nonexistent route on both baseline and
target, the model correctly recognized both sides rendered the identical client-rendered
"not found" state and returned `expected-divergence` at 0% diff — not the "right" verdict
label, but a safe, non-alarming one. Improving this (e.g. content-based not-found
detection) would be real, separate scope, not attempted here.

## Full-page screenshots, and the primary/secondary finding split

`captureAndDiff.ts` always screenshots `fullPage: true` — below-the-fold regressions
matter as much as above-the-fold ones. Since a full-page diff can surface something real
that's unrelated to what the check was actually for, `submit_verdict`'s schema captures
a `primary_finding` (drives the verdict) and a `secondary_findings` array (reported,
never affecting the verdict) — see `src/cli/output.ts`'s `exitCodeFor()`, which reads
only `verdict`.

## Dimension mismatches between environments

`pixelmatch` requires both images to be the exact same dimensions, but two environments'
full-page screenshots can legitimately differ in height (different content length, not a
bug). `captureAndDiff.ts`'s `padToMatch()` pads both onto a shared canvas sized to the
larger of the two before diffing, rather than cropping or erroring — the padded region
then genuinely shows up as fully different in the overlay, and the tool's own text
output flags the dimension mismatch explicitly so the model doesn't mistake it for a
real layout break.

## Where to find what

- `src/policy/visualRegressionPrompt.ts` — `buildVisualRegressionPrompt()`: Phase 0
  (tool surfaces), Phase 1 (load TC context via `get_scenario`, if given), Phase 2 (call
  `capture_and_diff` exactly once — its `not-applicable` determination is authoritative),
  Phase 3 (judge: `regression`/`expected-divergence`/`inconclusive`, with explicit
  criteria for each, plus the primary/secondary finding split), Phase 4 (report — cite
  the real diff percentage, describe specifically what changed, list secondary
  observations separately).
- `src/orchestrator/visualRegression.ts` — `checkVisualRegression()`: builds the tool
  palette, routes `capture_and_diff` to `CaptureAndDiffTool`, `submit_verdict` to
  `VerdictCapture`, everything else to the gated appq dispatcher. Captures the real diff
  stats and the model's structured verdict out of the dispatch closures rather than
  parsing `runLoop()`'s final report text.
- `src/tools/captureAndDiff.ts` — `CaptureAndDiffTool`/`CAPTURE_TOOL_DEFS`: the one real
  piece of new mechanism. Launches its own browser (optionally with `storageState`),
  navigates baseline then target, masks configured selectors, full-page screenshots,
  pixel-diffs via `pixelmatch`/`pngjs`, returns both real screenshots plus a diff overlay
  as eagerly-attached `images` (mandatory pattern — same reasoning
  `appliqation-autotest`'s `screenshotViewer.ts` documents: an eager fetch doesn't depend
  on model compliance) plus real stats in `text`.
- `src/tools/verdictTool.ts` — `SUBMIT_VERDICT_TOOL_DEF`/`VerdictCapture`: how the
  model's judgment reaches this process as structured data instead of free-text prose.
- `src/tools/safety.ts` — `READONLY_CONTEXT_TOOLS`: just `get_scenario`. Zero write
  tools, genuinely absent — this agent never calls an appq write tool.
- `src/cli/index.ts` — the `check` command. `--test-case-uuid` is required (derives
  `project_id` via `resolveScenarioId`/`fetchScenarioInfo`, same as every sibling — never
  a raw `--project-id` flag); `--route` is always explicit (no structured route data
  exists to derive it from); `--baseline-environment`/`--target-environment` are resolved
  via two `resolveUrl()` calls before the loop starts, so a missing environment name
  surfaces as a clear pre-flight error, never a wasted agent run; `--mask` is repeatable;
  `--storage-state` is optional, for auth-gated routes.
- `src/cli/output.ts` — `VisualRegressionSummary`/`exitCodeFor()`: 0 for
  `expected-divergence`/`not-applicable`, 1 for `regression`/`inconclusive` — driven only
  by `verdict`, never by `secondaryFindings`.
- `src/cli/audit.ts` — `recordVisualRegressionRun()`, same extraction-for-testability
  pattern as every sibling. A missing verdict (model never called `submit_verdict`,
  e.g. ran out of budget) is recorded as `inconclusive`, fail-closed.
- `src/config/env.ts` — this agent's own config. Deliberately tighter default budget
  than `heal-selector`'s (`BUDGET_MAX_CALLS`/`_TURNS` both lower) — the mechanical work is
  fixed-cost inside one tool call, the model's only real work is one judgment call.

## Explicitly out of scope for v1

- Route enumeration/inference from scenario data — always caller-supplied via `--route`.
- AI-driven auto-masking of dynamic regions — caller-supplied CSS selectors only.
- Any appq write tool (`create_defect` on a confirmed regression) — report-only.
- Comparison against a design file/Figma mock — different problem, not regression
  detection.
- ID/slug-based dynamic-content routes (`/blog/123` vs `/blog/345`) — single `--route`
  assumes path identity means content identity; no equivalence-resolution built.
- Reproducing multi-step application state beyond auth (cart contents, a partially
  filled form) — direct-navigation only.
- Wiring into `appliqation-autopilot` as a meta-tool. When it happens, there isn't one
  centralized caller: Autopilot's own top-down path (a TC `Tag: visual` plus a `--visual`
  authorization flag, same hardcoded-exclusion pattern `--allow-pr` already uses for
  `run_pr_raise`) and a bottom-up reactive path from `appliqation-explorer` or
  `appq:autotest-validator` (an in-the-moment "this seems visually significant, let me
  check" escalation from a session already in the deeper, judgment-bearing tier — never
  from `autotest`'s own deterministic sweep, which stays cheap on purpose) are both
  legitimate, and this agent's CLI/tool contract stays identical either way.

## Commands

- `npm run dev -- check --test-case-uuid <uuid> --route </path> --baseline-environment <name> --target-environment <name> [--mask <selector>]... [--storage-state <path>] [--json|--ci]`
- `npm run build` / `npm run typecheck`
- `npm test` / `npm run test:watch` — vitest, colocated `src/**/*.test.ts` files
- `npx playwright install chromium` — needed once before a real (non-mocked) run

## Config

Copy `.env.example` to `.env`. Requires `APPQ_API_KEY` (read-only access is sufficient —
this agent never calls an appq write tool) and one of `ANTHROPIC_API_KEY`/
`OPENAI_API_KEY`.

## Keeping this file current

When you add, remove, or rename a top-level file or a directory under `src/`, update
the map above in the same change.
