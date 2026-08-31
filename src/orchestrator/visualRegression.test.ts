import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetchAppqToolDefs, mockCreateGatedAppqDispatcher, mockRunLoop } = vi.hoisted(() => ({
  mockFetchAppqToolDefs: vi.fn(),
  mockCreateGatedAppqDispatcher: vi.fn(),
  mockRunLoop: vi.fn(),
}));
vi.mock('@appliqation/agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@appliqation/agent-core')>();
  return {
    ...actual,
    fetchAppqToolDefs: mockFetchAppqToolDefs,
    createGatedAppqDispatcher: mockCreateGatedAppqDispatcher,
    runLoop: mockRunLoop,
  };
});

const { mockCaptureDispatch, MockCaptureAndDiffTool } = vi.hoisted(() => {
  const mockCaptureDispatch = vi.fn();
  class MockCaptureAndDiffTool {
    dispatch = mockCaptureDispatch;
  }
  return { mockCaptureDispatch, MockCaptureAndDiffTool };
});
vi.mock('../tools/captureAndDiff.js', () => ({
  CaptureAndDiffTool: MockCaptureAndDiffTool,
  CAPTURE_TOOL_DEFS: [{ name: 'capture_and_diff', description: 'x', inputSchema: { type: 'object', properties: {} } }],
}));

import { checkVisualRegression } from './visualRegression.js';
import type { McpClient, ProviderAdapter, RunBudget } from '@appliqation/agent-core';

function fakeClient(): McpClient {
  return {
    fetchPrompt: vi.fn(),
    startWorkflow: vi.fn(),
    callTool: vi.fn(),
    listTools: vi.fn(),
    uploadScreenshot: vi.fn(),
  };
}

const budget: RunBudget = { maxCalls: 15, maxPages: 10, maxMillis: 300_000, maxTurns: 10 };

function baseOpts() {
  return {
    client: fakeClient(),
    adapter: { complete: vi.fn() } as ProviderAdapter,
    testCaseUuid: '2424-abc',
    route: '/subscribe',
    baselineUrl: 'https://prod.example.com/subscribe',
    targetUrl: 'https://stage.example.com/subscribe',
    maskSelectors: ['.reader-count'],
    budget,
  };
}

describe('checkVisualRegression', () => {
  beforeEach(() => {
    mockFetchAppqToolDefs.mockReset().mockResolvedValue([{ name: 'get_scenario', description: 'x', inputSchema: {} }]);
    mockCreateGatedAppqDispatcher.mockReset().mockReturnValue(vi.fn().mockResolvedValue({ ok: true, text: 'appq result' }));
    mockRunLoop.mockReset().mockResolvedValue({ report: 'done', turns: 3, budgetExceeded: false });
    mockCaptureDispatch.mockReset().mockResolvedValue({ ok: true, text: 'capture result' });
  });

  it('calls runLoop with the local visual-regression policy as the system prompt — no appq-served prompt exists for this', async () => {
    await checkVisualRegression(baseOpts());
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.system).toContain('check ONE route');
  });

  it('the seed message includes the route, both URLs, and masks', async () => {
    await checkVisualRegression(baseOpts());
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.seedMessage).toContain('/subscribe');
    expect(call.seedMessage).toContain('https://prod.example.com/subscribe');
    expect(call.seedMessage).toContain('https://stage.example.com/subscribe');
    expect(call.seedMessage).toContain('.reader-count');
  });

  it('fetches get_scenario tool defs only when a testCaseUuid is given', async () => {
    await checkVisualRegression(baseOpts());
    expect(mockFetchAppqToolDefs).toHaveBeenCalled();

    mockFetchAppqToolDefs.mockClear();
    mockRunLoop.mockClear();
    const { testCaseUuid: _testCaseUuid, ...withoutTc } = baseOpts();
    await checkVisualRegression(withoutTc);
    expect(mockFetchAppqToolDefs).not.toHaveBeenCalled();
    const call = mockRunLoop.mock.calls[0][0];
    expect(call.seedMessage).toContain('No test case given');
  });

  it('offers capture_and_diff and submit_verdict alongside appq context tools', async () => {
    await checkVisualRegression(baseOpts());
    const call = mockRunLoop.mock.calls[0][0];
    const toolNames = call.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(['get_scenario', 'capture_and_diff', 'submit_verdict']));
  });

  it('never offers browser_* tools — the mechanical pipeline is code-owned, not model-driven', async () => {
    await checkVisualRegression(baseOpts());
    const call = mockRunLoop.mock.calls[0][0];
    const toolNames = call.tools.map((t: { name: string }) => t.name);
    expect(toolNames.some((n: string) => n.startsWith('browser_'))).toBe(false);
  });

  it('routes capture_and_diff to the capture tool, submit_verdict to the verdict capture, everything else to the gated appq dispatcher', async () => {
    await checkVisualRegression(baseOpts());
    const dispatch = mockRunLoop.mock.calls[0][0].dispatch;

    await dispatch('capture_and_diff', {});
    expect(mockCaptureDispatch).toHaveBeenCalledWith('capture_and_diff', {});

    await dispatch('submit_verdict', { verdict: 'regression', primary_finding: 'x' });

    const gatedFn = mockCreateGatedAppqDispatcher.mock.results[0].value;
    await dispatch('get_scenario', { scenario_id: 2424 });
    expect(gatedFn).toHaveBeenCalledWith('get_scenario', { scenario_id: 2424 });
  });

  it('captures the verdict submitted via submit_verdict into the final result', async () => {
    mockRunLoop.mockImplementation(async (args: { dispatch: (name: string, a: Record<string, unknown>) => Promise<unknown> }) => {
      await args.dispatch('submit_verdict', { verdict: 'regression', primary_finding: 'button missing', secondary_findings: ['footer glitch'] });
      return { report: 'done', turns: 2, budgetExceeded: false };
    });
    const result = await checkVisualRegression(baseOpts());
    expect(result.verdict).toBe('regression');
    expect(result.primaryFinding).toBe('button missing');
    expect(result.secondaryFindings).toEqual(['footer glitch']);
  });

  it('verdict is undefined when the model never calls submit_verdict — CLI layer treats this as inconclusive', async () => {
    const result = await checkVisualRegression(baseOpts());
    expect(result.verdict).toBeUndefined();
  });

  it('diffRan is true once capture_and_diff actually ran, and surfaces its real diff stats', async () => {
    mockCaptureDispatch.mockResolvedValue({ ok: true, text: 'x', data: { diffPixelCount: 77, diffPercentage: 3.2 } });
    mockRunLoop.mockImplementation(async (args: { dispatch: (name: string, a: Record<string, unknown>) => Promise<unknown> }) => {
      await args.dispatch('capture_and_diff', {});
      return { report: 'done', turns: 2, budgetExceeded: false };
    });
    const result = await checkVisualRegression(baseOpts());
    expect(result.diffRan).toBe(true);
    expect(result.diffPixelCount).toBe(77);
    expect(result.diffPercentage).toBe(3.2);
  });

  it('diffRan is false and diff stats are null when capture_and_diff was never called', async () => {
    const result = await checkVisualRegression(baseOpts());
    expect(result.diffRan).toBe(false);
    expect(result.diffPixelCount).toBeNull();
    expect(result.diffPercentage).toBeNull();
  });

  it('returns loopResult.report/turns/budgetExceeded unchanged', async () => {
    mockRunLoop.mockResolvedValue({ report: 'my report', turns: 5, budgetExceeded: true });
    const result = await checkVisualRegression(baseOpts());
    expect(result.report).toBe('my report');
    expect(result.turns).toBe(5);
    expect(result.budgetExceeded).toBe(true);
  });
});
