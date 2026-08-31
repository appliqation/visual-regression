# Appliqation Visual-Regression

**Checks one route for a real visual regression by diffing it against its own live production counterpart: no stored baseline files, no manual baseline-approval workflow.**

Point it at a route and a test case. It navigates to that route on production and a target environment, masks any known dynamic regions, full-page screenshots both, pixel-diffs them for real, and has a model judge the result from the actual evidence: a genuine regression, an expected divergence, or a route that simply doesn't exist on production yet (declines rather than substituting any other baseline).

## Why this exists

A Playwright `getByRole` assertion can pass while the page looks broken: an overlapping modal, a button pushed off-screen by a CSS regression, invisible text from a contrast bug. Nothing else in this agent family checks appearance, only behaviour. Traditional visual-regression tooling solves this with a stored baseline image that a human has to keep re-approving every time a legitimate UI change ships; in practice, that maintenance burden is what kills most setups. This agent sidesteps it entirely by using **production itself as the baseline, fetched live at comparison time**. Production always represents current truth by definition; there's nothing to store or re-approve.

## The one rule that matters more than anything else here

**If the route doesn't exist on production, that's not a failure: it's not applicable.** This agent never falls back to comparing against a design file or mock (a live render vs. a Figma file is a different, unreliable problem: design fidelity, not regression detection). No production equivalent means no comparison, reported plainly, nothing forced.

The mechanical work (navigating both environments, masking, screenshotting, pixel-diffing) is entirely code-owned, never something the model claims: it happens inside one atomic `capture_and_diff` call, and the real diff statistics it returns are what the model is required to cite, never a number it asserts on its own. The model's only real job is judgment, reported back through a structured `submit_verdict` call rather than free-text prose, the same discipline `appq:autotest-validator` already uses for its own verdicts.

## Quick start

```bash
npm install -g @appliqation/visual-regression
npx playwright install chromium
```

Create a `.env` file (in whatever directory you'll run it from) with:

```
APPQ_API_KEY=your-appliqation-api-key   # read-only is enough
ANTHROPIC_API_KEY=your-anthropic-key    # or OPENAI_API_KEY (pick one)
```

```bash
appliqation-visual-regression check \
  --test-case-uuid 1350-2732cd99-81d6-44ce-a053-1aa2e2efc42c \
  --route /subscribe \
  --baseline-environment Prod \
  --target-environment Stage \
  --mask ".reader-count" \
  --mask "[data-testid=timestamp]"
```

Add `--json`/`--ci` for a structured summary. The exit code is 0 for `expected-divergence`/`not-applicable`, 1 for `regression`/`inconclusive` (fail-closed on ambiguity). The JSON summary's `verdict` field is what actually distinguishes the outcomes, not the exit code alone.

## What this agent does not do (on purpose)

- **No route enumeration or inference.** `--route` is always explicit; there's no structured route data on a scenario/test case to derive it from (confirmed: routes only ever exist inside free-text step descriptions). A real caller with a just-completed run derives it from real observed navigation data (`get_execution_evidence`), never by guessing at step text.
- **No auto-detection of dynamic regions.** `--mask` is caller-supplied CSS selectors only. The model already has to reason about "is this difference data-driven or a real break" regardless, so masking is an optimization, not a prerequisite.
- **No write capability.** This agent never calls an Appliqation write tool and never files a defect; it reports a verdict, nothing else. What happens to a confirmed regression (or a secondary observation) is entirely the caller's decision.
- **No ID/slug-based dynamic-content routes.** `/blog/123` on staging has no reliable way to be matched to its "equivalent" content on production (`/blog/345`) without this agent guessing at content equivalence: a single `--route` assumes path identity means content identity. Static, stable routes only.
- **No multi-step workflow replay.** This agent navigates directly to a URL; it doesn't replay a login flow or rebuild cart state. Auth-gated pages are covered via `--storage-state`; deeper application state built up through a workflow is not.

## Primary finding vs. secondary observations

A full-page diff can surface something real that's unrelated to what the check was actually for. The verdict carries one **primary finding** (what drove the classification) and a separate list of **secondary observations**: other real differences noticed elsewhere on the page. Secondary observations are always reported, never silently dropped, and never affect the verdict or exit code.

## Configuration

Copy `.env.example` to `.env`. Requires `APPQ_API_KEY` (read-only access is sufficient; this agent never calls an appq write tool) and one of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`.

## Running this safely

This agent has a real browser and navigates to whatever URLs `--baseline-environment`/`--target-environment` resolve to. It has no filesystem write access and no shell surface at all (unlike `heal-selector`/`scriptgen`, it never patches anything).

**Run this inside a container with an egress allowlist**, same as every agent in this family. This process only ever legitimately needs to reach:

- your LLM provider (`api.anthropic.com` or `api.openai.com`)
- your configured `APPQ_ORIGIN` (`appq.appliqation.io` by default)
- the two sites under test (whatever `--baseline-environment`/`--target-environment` resolve to)

Anything else this process tries to reach is unexpected and worth investigating.

## Development

```bash
git clone https://github.com/appliqation/visual-regression.git
cd visual-regression
npm install
cp .env.example .env   # fill in APPQ_API_KEY (read-only) and an LLM key
npm run dev -- check --test-case-uuid <uuid> --route </path> --baseline-environment <name> --target-environment <name>
npm run typecheck
npm test
```

See `CLAUDE.md` for a map of this repo if you're working in it with an AI coding assistant.

## License

MIT. See [LICENSE](./LICENSE).
