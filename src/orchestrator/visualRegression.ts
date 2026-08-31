// Drives the visual-regression methodology (src/policy/visualRegressionPrompt.ts
// — no appq-served prompt exists for this, so runLoop() is used directly,
// same pattern appliqation-heal-selector/appliqation-autopilot use for their
// own local policies). Deliberately NOT the browser+coding-tools composition
// heal-selector uses — this agent never exposes BROWSER_TOOL_DEFS to the
// model at all; the entire mechanical pipeline is one atomic, code-owned
// tool (capture_and_diff). The model's only real work is judgment, captured
// through a second tool (submit_verdict) as structured data, never parsed
// out of free-text report prose.

import {
  runLoop,
  fetchAppqToolDefs,
  createGatedAppqDispatcher,
  type McpClient,
  type ProviderAdapter,
  type RunBudget,
  type ToolDispatcher,
  type ToolResult,
} from '@appliqation/agent-core';
import { READONLY_CONTEXT_TOOLS } from '../tools/safety.js';
import { CAPTURE_TOOL_DEFS, CaptureAndDiffTool } from '../tools/captureAndDiff.js';
import { SUBMIT_VERDICT_TOOL_DEF, VerdictCapture, type Verdict } from '../tools/verdictTool.js';
import { buildVisualRegressionPrompt } from '../policy/visualRegressionPrompt.js';

export interface VisualRegressionOptions {
  client: McpClient;
  adapter: ProviderAdapter;
  /** Optional — when given, get_scenario supplies expected_result context for the judge. */
  testCaseUuid?: string;
  route: string;
  baselineUrl: string;
  targetUrl: string;
  maskSelectors: string[];
  storageStatePath?: string;
  budget: RunBudget;
  onEvent?: (event: { type: string; detail?: unknown }) => void;
}

export interface VisualRegressionResult {
  report: string;
  turns: number;
  budgetExceeded: boolean;
  /** True once capture_and_diff actually ran (not-applicable counts as ran — it's a real, executed determination). */
  diffRan: boolean;
  diffPixelCount: number | null;
  diffPercentage: number | null;
  /**
   * undefined only if the model never called submit_verdict at all (e.g. the
   * budget ran out before it did) — the CLI treats that as inconclusive,
   * fail-closed, same as an ambiguous evidence read.
   */
  verdict: Verdict | undefined;
  primaryFinding: string;
  secondaryFindings: string[];
}

function seedMessage(opts: VisualRegressionOptions): string {
  const lines = [
    `Route being checked: ${opts.route}`,
    `Baseline (production) URL: ${opts.baselineUrl}`,
    `Target URL: ${opts.targetUrl}`,
    `Masked selectors: ${opts.maskSelectors.length > 0 ? opts.maskSelectors.join(', ') : '(none configured)'}`,
  ];
  if (opts.testCaseUuid) {
    lines.push(`Test case UUID (for context via get_scenario): ${opts.testCaseUuid}`);
  } else {
    lines.push('No test case given — no expected_result context available; judge from the screenshots alone.');
  }
  lines.push('Begin now — call capture_and_diff.');
  return lines.join('\n');
}

export async function checkVisualRegression(opts: VisualRegressionOptions): Promise<VisualRegressionResult> {
  const appqToolDefs = opts.testCaseUuid ? await fetchAppqToolDefs(opts.client, READONLY_CONTEXT_TOOLS) : [];
  const gatedAppq = createGatedAppqDispatcher(opts.client, READONLY_CONTEXT_TOOLS);

  const capture = new CaptureAndDiffTool({
    baselineUrl: opts.baselineUrl,
    targetUrl: opts.targetUrl,
    maskSelectors: opts.maskSelectors,
    storageStatePath: opts.storageStatePath,
  });
  const verdictCapture = new VerdictCapture();

  let diffRan = false;
  const diffState: { data: { diffPixelCount: number; diffPercentage: number } | null } = { data: null };

  const dispatch: ToolDispatcher = async (name, args) => {
    if (name === 'capture_and_diff') {
      const result: ToolResult = await capture.dispatch(name, args);
      diffRan = true;
      const data = result.data as { diffPixelCount?: number; diffPercentage?: number } | undefined;
      if (data && typeof data.diffPixelCount === 'number' && typeof data.diffPercentage === 'number') {
        diffState.data = { diffPixelCount: data.diffPixelCount, diffPercentage: data.diffPercentage };
      }
      return result;
    }
    if (name === 'submit_verdict') return verdictCapture.dispatch(name, args);
    return gatedAppq(name, args);
  };

  const loopResult = await runLoop({
    adapter: opts.adapter,
    system: buildVisualRegressionPrompt(),
    seedMessage: seedMessage(opts),
    tools: [...appqToolDefs, ...CAPTURE_TOOL_DEFS, SUBMIT_VERDICT_TOOL_DEF],
    dispatch,
    budget: opts.budget,
    onEvent: opts.onEvent,
  });

  const verdict = verdictCapture.get();

  return {
    report: loopResult.report,
    turns: loopResult.turns,
    budgetExceeded: loopResult.budgetExceeded,
    diffRan,
    diffPixelCount: diffState.data?.diffPixelCount ?? null,
    diffPercentage: diffState.data?.diffPercentage ?? null,
    verdict: verdict?.verdict,
    primaryFinding: verdict?.primaryFinding ?? '',
    secondaryFindings: verdict?.secondaryFindings ?? [],
  };
}
