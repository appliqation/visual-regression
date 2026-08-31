// The verdict itself is inherently a judgment call — unlike heal-selector's
// declined/verified (both derivable from real code signals: file writes, a
// real command exit code), there's no objective code-computed equivalent
// for "is this a regression." Rather than parse it out of free-text report
// prose (fragile), the model reports it through a real tool call's
// structured arguments — same discipline `appq:autotest-validator` already
// uses (writing its verdict via `update_run_results`'s real enum argument,
// not asserting it in prose). This tool never causes a side effect; it's
// purely how the model's judgment reaches this process as structured data.

import type { LlmToolDef, ToolResult } from '@appliqation/agent-core';

export type Verdict = 'regression' | 'expected-divergence' | 'not-applicable' | 'inconclusive';

export const SUBMIT_VERDICT_TOOL_DEF: LlmToolDef = {
  name: 'submit_verdict',
  description:
    'Report your final judgment. Call this exactly once, after capture_and_diff (and get_scenario, if a ' +
    'test case was given) — never before you have the real diff evidence. This is how your verdict reaches ' +
    'the caller; a verdict only stated in your closing prose is not captured.',
  inputSchema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['regression', 'expected-divergence', 'not-applicable', 'inconclusive'],
        description:
          'regression = a real visible break. expected-divergence = pixels differ but for a legitimate ' +
          'reason (data, a new unreleased feature, a staging banner). inconclusive = you genuinely cannot ' +
          'tell — fail closed. not-applicable = only ever set because capture_and_diff itself pre-determined ' +
          'it (route missing on baseline) — never decide this yourself in any other case.',
      },
      primary_finding: {
        type: 'string',
        description: 'The one finding most connected to what this check was for — what drove the verdict above. Be specific about what and where.',
      },
      secondary_findings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Other real differences noticed elsewhere on the page, unrelated to the primary finding. Empty array if none. Never affects the verdict above.',
      },
    },
    required: ['verdict', 'primary_finding'],
  },
};

export interface CapturedVerdict {
  verdict: Verdict;
  primaryFinding: string;
  secondaryFindings: string[];
}

export class VerdictCapture {
  private captured: CapturedVerdict | undefined;

  dispatch(name: string, args: Record<string, unknown>): ToolResult {
    if (name !== 'submit_verdict') return { ok: false, text: `Unknown tool: ${name}` };
    const verdict = args.verdict as Verdict;
    const primaryFinding = String(args.primary_finding ?? '');
    const secondaryFindings = Array.isArray(args.secondary_findings) ? args.secondary_findings.map(String) : [];
    this.captured = { verdict, primaryFinding, secondaryFindings };
    return { ok: true, text: 'Verdict recorded.' };
  }

  get(): CapturedVerdict | undefined {
    return this.captured;
  }
}
