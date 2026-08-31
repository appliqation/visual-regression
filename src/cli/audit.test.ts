import { describe, it, expect, vi } from 'vitest';
import { recordVisualRegressionRun } from './audit.js';
import type { AuditSink } from '@appliqation/agent-core';
import type { VisualRegressionResult } from '../orchestrator/visualRegression.js';

const usage = { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0 };

function baseArgs(overrides: { result?: VisualRegressionResult } = {}) {
  return {
    startedAt: 1000,
    endedAt: 3000,
    model: 'claude-sonnet-5',
    usage,
    route: '/subscribe',
    baselineUrl: 'https://prod.example.com/subscribe',
    targetUrl: 'https://stage.example.com/subscribe',
    testCaseUuid: '2424-abc',
    result: overrides.result,
  };
}

describe('recordVisualRegressionRun', () => {
  it('records one call with agent/subcommand and the outcome shaped like VisualRegressionSummary', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordVisualRegressionRun({
      sink,
      ...baseArgs({
        result: {
          report: 'looks fine',
          turns: 3,
          budgetExceeded: false,
          diffRan: true,
          diffPixelCount: 50,
          diffPercentage: 0.8,
          verdict: 'expected-divergence',
          primaryFinding: 'different reader count, data not layout',
          secondaryFindings: [],
        },
      }),
    });

    expect(sink.record).toHaveBeenCalledTimes(1);
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record).toMatchObject({
      agent: 'appliqation-visual-regression',
      subcommand: 'check',
      startedAt: 1000,
      endedAt: 3000,
      durationMillis: 2000,
      model: 'claude-sonnet-5',
      usage,
      exitCode: 0,
    });
    expect(record.outcome).toMatchObject({
      route: '/subscribe',
      verdict: 'expected-divergence',
      testCaseUuid: '2424-abc',
    });
  });

  it('a missing verdict (model never called submit_verdict) is recorded as inconclusive, exitCode 1', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordVisualRegressionRun({
      sink,
      ...baseArgs({
        result: {
          report: 'ran out of budget',
          turns: 10,
          budgetExceeded: true,
          diffRan: true,
          diffPixelCount: 10,
          diffPercentage: 0.1,
          verdict: undefined,
          primaryFinding: '',
          secondaryFindings: [],
        },
      }),
    });
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.outcome.verdict).toBe('inconclusive');
    expect(record.exitCode).toBe(1);
  });

  it('records exitCode 1 and an error outcome when result is undefined — checkVisualRegression() threw', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordVisualRegressionRun({ sink, ...baseArgs({ result: undefined }) });
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.exitCode).toBe(1);
    expect(record.outcome).toEqual({
      route: '/subscribe',
      baselineUrl: 'https://prod.example.com/subscribe',
      targetUrl: 'https://stage.example.com/subscribe',
      testCaseUuid: '2424-abc',
      error: true,
    });
  });

  it('a sink failure never rejects — safeRecord swallows it', async () => {
    const sink: AuditSink = { record: vi.fn().mockRejectedValue(new Error('down')), close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordVisualRegressionRun({ sink, ...baseArgs({ result: undefined }) })).resolves.toBeUndefined();
  });

  it('closes the sink after recording', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordVisualRegressionRun({ sink, ...baseArgs({ result: undefined }) });
    expect(sink.close).toHaveBeenCalledTimes(1);
  });
});
