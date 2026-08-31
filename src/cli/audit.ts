// Extracted out of cli/index.ts so this is testable without triggering that
// file's top-level program.parseAsync(process.argv) side effect — same
// reasoning as every sibling agent's audit module.

import { safeRecord, safeClose, type AuditSink, type AuditRecord } from '@appliqation/agent-core';
import type { VisualRegressionResult } from '../orchestrator/visualRegression.js';
import { exitCodeFor } from './output.js';
import type { VisualRegressionSummary, Verdict } from './output.js';

export interface RecordVisualRegressionRunArgs {
  sink: AuditSink;
  startedAt: number;
  endedAt: number;
  model: string;
  usage: AuditRecord['usage'];
  route: string;
  baselineUrl: string;
  targetUrl: string;
  testCaseUuid?: string;
  /** undefined means checkVisualRegression() threw — the run never produced a result. */
  result: VisualRegressionResult | undefined;
}

export async function recordVisualRegressionRun(args: RecordVisualRegressionRunArgs): Promise<void> {
  const { sink, startedAt, endedAt, model, usage, route, baselineUrl, targetUrl, testCaseUuid, result } = args;
  const summary: VisualRegressionSummary | undefined = result
    ? {
        route,
        baselineUrl,
        targetUrl,
        diffRan: result.diffRan,
        diffPixelCount: result.diffPixelCount,
        diffPercentage: result.diffPercentage,
        verdict: (result.verdict ?? 'inconclusive') as Verdict,
        primaryFinding: result.primaryFinding,
        secondaryFindings: result.secondaryFindings,
        report: result.report,
      }
    : undefined;

  await safeRecord(sink, {
    agent: 'appliqation-visual-regression',
    subcommand: 'check',
    startedAt,
    endedAt,
    durationMillis: endedAt - startedAt,
    model,
    usage,
    turns: result?.turns,
    budgetExceeded: result?.budgetExceeded,
    exitCode: summary ? exitCodeFor(summary) : 1,
    outcome: summary ? { ...summary, testCaseUuid } : { route, baselineUrl, targetUrl, testCaseUuid, error: true },
  });
  await safeClose(sink);
}
