#!/usr/bin/env node
// `check`: compare one route between production and a target environment for
// a real visual regression. See src/orchestrator/visualRegression.ts for the
// mechanism and src/policy/visualRegressionPrompt.ts for the actual
// methodology (no appq-served prompt exists for this yet — the policy is
// local, bundled here).
//
// Generic, caller-agnostic inputs — not designed around any one caller.
// project_id is always derived from --test-case-uuid, never accepted as a
// separate input, same reasoning as every sibling agent. --route stays a
// single, caller-supplied string — no route enumeration/inference (no
// structured route data exists on scenarios/test cases to derive it from).

import { Command } from 'commander';
import {
  createMcpClient,
  createAnthropicAdapter,
  createOpenAiAdapter,
  createOpenAiCompatibleAdapter,
  createUsageAccumulator,
  resolveScenarioId,
  fetchScenarioInfo,
  resolveUrl,
  type ProviderAdapter,
} from '@appliqation/agent-core';
import { config, resolveProvider, resolveModel } from '../config/env.js';
import { checkVisualRegression } from '../orchestrator/visualRegression.js';
import type { VisualRegressionResult } from '../orchestrator/visualRegression.js';
import { recordVisualRegressionRun } from './audit.js';
import { printJsonSummary, printHumanSummary, exitCodeFor } from './output.js';
import type { VisualRegressionSummary, Verdict } from './output.js';

const client = createMcpClient({ origin: config.appqOrigin, apiKey: config.appqApiKey() });

function buildAdapter(): ProviderAdapter {
  const provider = resolveProvider();
  const model = resolveModel();
  if (provider === 'anthropic') return createAnthropicAdapter(config.anthropicApiKey!, model, config.anthropicMaxTokens);
  if (provider === 'openai') return createOpenAiAdapter(config.openaiApiKey!, model, config.openaiMaxOutputTokens);
  if (provider === 'deepseek') {
    return createOpenAiCompatibleAdapter({ apiKey: config.deepseekApiKey!, baseURL: config.deepseekBaseUrl, model, maxTokens: config.deepseekMaxTokens, providerLabel: 'DeepSeek' });
  }
  return createOpenAiCompatibleAdapter({ apiKey: config.glmApiKey!, baseURL: config.glmBaseUrl, model, maxTokens: config.glmMaxTokens, providerLabel: 'GLM' });
}

function logEvent(prefix: string) {
  return (e: { type: string; detail?: unknown }) => {
    if (e.type === 'assistant') {
      const text = ((e.detail as string) ?? '').trim();
      if (text) console.error(`${prefix}[thinking] ${text}`);
    } else if (e.type === 'tool') {
      const d = e.detail as { name: string; result: string };
      console.error(`${prefix}[tool] ${d.name} -> ${d.result.slice(0, 300)}`);
    } else if (e.type === 'log') {
      console.error(`${prefix}[log] ${e.detail}`);
    } else if (e.type === 'usage') {
      const u = e.detail as { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number };
      const cacheNote = u.cacheReadTokens
        ? ` (${u.cacheReadTokens} from cache)`
        : u.cacheWriteTokens
          ? ` (${u.cacheWriteTokens} written to cache)`
          : '';
      console.error(`${prefix}[usage] in=${u.inputTokens} out=${u.outputTokens}${cacheNote}`);
    }
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Joins a base environment URL with a route path — an absolute route (leading "/") replaces the base's own path, same as any URL resolution. */
function joinRoute(baseUrl: string, route: string): string {
  return new URL(route, baseUrl).toString();
}

const program = new Command();
program
  .name('appliqation-visual-regression')
  .description(
    'Check one route for a real visual regression by diffing it against its own live production ' +
      'counterpart — no stored baseline files, no manual baseline-approval workflow. Declines rather than ' +
      'compares when the route does not exist on production. See README.md for the full story.',
  );

program
  .command('check')
  .description(
    'Navigate to the same route on a baseline (production) and target environment, mask configured ' +
      'dynamic regions, full-page screenshot both, pixel-diff them for real, and have the model judge ' +
      "regression vs. expected divergence vs. inconclusive — never the model's own claim about the pixels, " +
      'always the real diff it was actually shown.',
  )
  .requiredOption('--test-case-uuid <uuid>', 'test case this route belongs to — derives project_id, supplies expected_result context')
  .requiredOption('--route </path>', 'the route to check, e.g. /subscribe — same route is checked on both environments')
  .requiredOption('--baseline-environment <name>', 'environment name treated as the source of truth (commonly, but not necessarily, "Prod")')
  .requiredOption('--target-environment <name>', 'environment name being checked against the baseline')
  .option('--mask <selector>', 'CSS selector to mask before capturing (repeatable) — reduces noise on known dynamic regions', collect, [])
  .option('--storage-state <path>', 'Playwright storageState file, for auth-gated routes')
  .option('--max-turns <n>', 'override BUDGET_MAX_TURNS for this run')
  .option('--json', 'print a single structured JSON summary on stdout instead of a human-readable report')
  .option('--ci', 'shorthand for --json; exit code already reflects the real verdict either way')
  .action(
    async (opts: {
      testCaseUuid: string;
      route: string;
      baselineEnvironment: string;
      targetEnvironment: string;
      mask: string[];
      storageState?: string;
      maxTurns?: string;
      json?: boolean;
      ci?: boolean;
    }) => {
      const json = (opts.json ?? false) || (opts.ci ?? false);
      const adapter = buildAdapter();

      const scenarioId = resolveScenarioId({ testCaseUuid: opts.testCaseUuid });
      const { projectId } = await fetchScenarioInfo(client, scenarioId);
      const [baselineBaseUrl, targetBaseUrl] = await Promise.all([
        resolveUrl(client, opts.baselineEnvironment, projectId),
        resolveUrl(client, opts.targetEnvironment, projectId),
      ]);
      const baselineUrl = joinRoute(baselineBaseUrl, opts.route);
      const targetUrl = joinRoute(targetBaseUrl, opts.route);

      const budget = { ...config.budget, ...(opts.maxTurns ? { maxTurns: Number(opts.maxTurns) } : {}) };

      const startedAt = Date.now();
      const usage = createUsageAccumulator();
      const baseLog = logEvent('');
      let result: VisualRegressionResult | undefined;
      try {
        result = await checkVisualRegression({
          client,
          adapter,
          testCaseUuid: opts.testCaseUuid,
          route: opts.route,
          baselineUrl,
          targetUrl,
          maskSelectors: opts.mask,
          storageStatePath: opts.storageState,
          budget,
          onEvent: (e) => {
            baseLog(e);
            if (e.type === 'usage') usage.onUsage(e.detail as { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number });
          },
        });
      } finally {
        // Audit write happens whether the run succeeded or threw — see
        // @appliqation/agent-core's audit/sink.ts: safeRecord() (used inside
        // recordVisualRegressionRun) never lets a failed/unreachable audit
        // sink affect this process's real outcome.
        await recordVisualRegressionRun({
          sink: config.auditSink,
          startedAt,
          endedAt: Date.now(),
          model: resolveModel(),
          usage: usage.totals(),
          route: opts.route,
          baselineUrl,
          targetUrl,
          testCaseUuid: opts.testCaseUuid,
          result,
        });
      }

      if (!json) {
        console.log('\n=== Report ===\n');
        console.log(result.report);
        console.error(`\n(${result.turns} turns, budget exceeded: ${result.budgetExceeded})`);
      }

      const summary: VisualRegressionSummary = {
        route: opts.route,
        baselineUrl,
        targetUrl,
        diffRan: result.diffRan,
        diffPixelCount: result.diffPixelCount,
        diffPercentage: result.diffPercentage,
        verdict: (result.verdict ?? 'inconclusive') as Verdict,
        primaryFinding: result.primaryFinding,
        secondaryFindings: result.secondaryFindings,
        report: result.report,
      };
      if (json) printJsonSummary(summary);
      else printHumanSummary(summary);
      process.exitCode = exitCodeFor(summary);
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
