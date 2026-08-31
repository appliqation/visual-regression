import { describe, it, expect } from 'vitest';
import { VerdictCapture, SUBMIT_VERDICT_TOOL_DEF } from './verdictTool.js';

describe('SUBMIT_VERDICT_TOOL_DEF', () => {
  it('requires verdict and primary_finding, with the four verdict values enumerated', () => {
    expect(SUBMIT_VERDICT_TOOL_DEF.inputSchema.required).toEqual(['verdict', 'primary_finding']);
    const props = SUBMIT_VERDICT_TOOL_DEF.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.verdict.enum).toEqual(['regression', 'expected-divergence', 'not-applicable', 'inconclusive']);
  });
});

describe('VerdictCapture', () => {
  it('returns undefined before any submit_verdict call', () => {
    const capture = new VerdictCapture();
    expect(capture.get()).toBeUndefined();
  });

  it('captures verdict, primary_finding, and secondary_findings from a real submit_verdict call', () => {
    const capture = new VerdictCapture();
    const result = capture.dispatch('submit_verdict', {
      verdict: 'regression',
      primary_finding: 'Subscribe button missing on target',
      secondary_findings: ['footer icon misaligned'],
    });
    expect(result.ok).toBe(true);
    expect(capture.get()).toEqual({
      verdict: 'regression',
      primaryFinding: 'Subscribe button missing on target',
      secondaryFindings: ['footer icon misaligned'],
    });
  });

  it('defaults secondaryFindings to an empty array when omitted', () => {
    const capture = new VerdictCapture();
    capture.dispatch('submit_verdict', { verdict: 'not-applicable', primary_finding: 'route missing on baseline' });
    expect(capture.get()?.secondaryFindings).toEqual([]);
  });

  it('rejects an unknown tool name', () => {
    const capture = new VerdictCapture();
    const result = capture.dispatch('some_other_tool', {});
    expect(result.ok).toBe(false);
    expect(capture.get()).toBeUndefined();
  });

  it('the latest call wins if called more than once', () => {
    const capture = new VerdictCapture();
    capture.dispatch('submit_verdict', { verdict: 'inconclusive', primary_finding: 'first' });
    capture.dispatch('submit_verdict', { verdict: 'regression', primary_finding: 'second' });
    expect(capture.get()?.verdict).toBe('regression');
    expect(capture.get()?.primaryFinding).toBe('second');
  });
});
