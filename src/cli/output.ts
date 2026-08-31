// --json/--ci's renderer, matching the family's shape (heal-selector/
// scriptgen/defect-fix output.ts). exitCodeFor() is driven only by
// `verdict` (the primary finding) — `secondaryFindings` never affects it,
// same reasoning the policy prompt gives the model: secondary observations
// are reported, never merged into the primary judgment.

export type Verdict = 'regression' | 'expected-divergence' | 'not-applicable' | 'inconclusive';

export interface VisualRegressionSummary {
  route: string;
  baselineUrl: string;
  targetUrl: string;
  diffRan: boolean;
  diffPixelCount: number | null;
  diffPercentage: number | null;
  verdict: Verdict;
  primaryFinding: string;
  secondaryFindings: string[];
  report: string;
}

export function printJsonSummary(summary: VisualRegressionSummary): void {
  console.log(JSON.stringify(summary, null, 2));
}

export function printHumanSummary(summary: VisualRegressionSummary): void {
  console.log(`\n=== ${summary.route} ===\n`);
  console.log(`  Baseline: ${summary.baselineUrl}`);
  console.log(`  Target:   ${summary.targetUrl}`);
  if (!summary.diffRan) {
    console.log('\n  capture_and_diff never actually ran — no verdict was computed.');
    return;
  }
  if (summary.diffPercentage !== null) {
    console.log(`  Diff: ${summary.diffPixelCount} pixels (${summary.diffPercentage.toFixed(2)}%)`);
  }
  console.log(`\n  Verdict: ${summary.verdict.toUpperCase()}`);
  console.log(`  Primary finding: ${summary.primaryFinding || '(none stated)'}`);
  if (summary.secondaryFindings.length > 0) {
    console.log('  Secondary observations (out of scope for this check):');
    for (const s of summary.secondaryFindings) console.log(`    - ${s}`);
  }
}

/** 0 for expected-divergence/not-applicable — nothing wrong, or nothing to check. 1 for regression/inconclusive — fail-closed on ambiguity, matching family convention. */
export function exitCodeFor(summary: VisualRegressionSummary): number {
  return summary.verdict === 'expected-divergence' || summary.verdict === 'not-applicable' ? 0 : 1;
}
