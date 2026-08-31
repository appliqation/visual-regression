import { describe, it, expect, vi } from 'vitest';
import { exitCodeFor, printJsonSummary, printHumanSummary } from './output.js';
import type { VisualRegressionSummary } from './output.js';

function summary(overrides: Partial<VisualRegressionSummary> = {}): VisualRegressionSummary {
  return {
    route: '/subscribe',
    baselineUrl: 'https://prod.example.com/subscribe',
    targetUrl: 'https://stage.example.com/subscribe',
    diffRan: true,
    diffPixelCount: 100,
    diffPercentage: 1.5,
    verdict: 'expected-divergence',
    primaryFinding: 'some finding',
    secondaryFindings: [],
    report: 'x',
    ...overrides,
  };
}

describe('exitCodeFor', () => {
  it('is 0 for expected-divergence', () => {
    expect(exitCodeFor(summary({ verdict: 'expected-divergence' }))).toBe(0);
  });

  it('is 0 for not-applicable', () => {
    expect(exitCodeFor(summary({ verdict: 'not-applicable' }))).toBe(0);
  });

  it('is 1 for regression', () => {
    expect(exitCodeFor(summary({ verdict: 'regression' }))).toBe(1);
  });

  it('is 1 for inconclusive — fail closed on ambiguity', () => {
    expect(exitCodeFor(summary({ verdict: 'inconclusive' }))).toBe(1);
  });

  it('is unaffected by secondaryFindings either way', () => {
    expect(exitCodeFor(summary({ verdict: 'regression', secondaryFindings: ['x', 'y'] }))).toBe(1);
    expect(exitCodeFor(summary({ verdict: 'expected-divergence', secondaryFindings: ['x', 'y'] }))).toBe(0);
  });
});

describe('printJsonSummary', () => {
  it('prints the summary as JSON, including verdict and secondaryFindings', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printJsonSummary(summary({ verdict: 'regression', secondaryFindings: ['unrelated footer glitch'] }));
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('"verdict": "regression"');
    expect(output).toContain('unrelated footer glitch');
    logSpy.mockRestore();
  });
});

describe('printHumanSummary', () => {
  it('reports the route, verdict, and primary finding', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary(summary({ verdict: 'regression', primaryFinding: 'Subscribe button missing on target' }));
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('/subscribe');
    expect(output).toContain('REGRESSION');
    expect(output).toContain('Subscribe button missing on target');
    logSpy.mockRestore();
  });

  it('lists secondary observations separately when present', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary(summary({ secondaryFindings: ['footer link icon broken'] }));
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toMatch(/Secondary observations/);
    expect(output).toContain('footer link icon broken');
    logSpy.mockRestore();
  });

  it('says the diff never ran when diffRan is false, and stops there', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary(summary({ diffRan: false, diffPixelCount: null, diffPercentage: null }));
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toMatch(/never actually ran/);
    logSpy.mockRestore();
  });
});
