import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLaunch } = vi.hoisted(() => ({ mockLaunch: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch: mockLaunch } }));

const { mockPixelmatch } = vi.hoisted(() => ({ mockPixelmatch: vi.fn() }));
vi.mock('pixelmatch', () => ({ default: mockPixelmatch }));

const { mockPngSyncRead, mockPngSyncWrite, MockPNG } = vi.hoisted(() => {
  const mockPngSyncRead = vi.fn();
  const mockPngSyncWrite = vi.fn();
  class MockPNG {
    width: number;
    height: number;
    data: Buffer;
    constructor(opts: { width: number; height: number }) {
      this.width = opts.width;
      this.height = opts.height;
      this.data = Buffer.alloc(opts.width * opts.height * 4);
    }
    static sync = { read: mockPngSyncRead, write: mockPngSyncWrite };
  }
  return { mockPngSyncRead, mockPngSyncWrite, MockPNG };
});
vi.mock('pngjs', () => ({ PNG: MockPNG }));

import { CaptureAndDiffTool } from './captureAndDiff.js';

function fakePage(overrides: Partial<{ status: number | null; screenshotBuffer: Buffer }> = {}) {
  const status = overrides.status ?? 200;
  return {
    goto: vi.fn().mockResolvedValue(status === null ? null : { status: () => status }),
    addStyleTag: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(overrides.screenshotBuffer ?? Buffer.from('fake-png-bytes')),
    locator: vi.fn((selector: string) => ({ selector })),
  };
}

function fakeBrowser(page: ReturnType<typeof fakePage>) {
  return {
    newContext: vi.fn().mockResolvedValue({ newPage: vi.fn().mockResolvedValue(page) }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const baseOpts = () => ({
  baselineUrl: 'https://prod.example.com/subscribe',
  targetUrl: 'https://stage.example.com/subscribe',
  maskSelectors: [] as string[],
});

describe('CaptureAndDiffTool', () => {
  beforeEach(() => {
    mockPngSyncRead.mockReset().mockReturnValue({ width: 10, height: 10, data: Buffer.alloc(10 * 10 * 4) });
    mockPngSyncWrite.mockReset().mockReturnValue(Buffer.from('fake-diff-png'));
    mockPixelmatch.mockReset().mockReturnValue(42);
  });

  it('rejects an unknown tool name without ever launching a browser', async () => {
    const tool = new CaptureAndDiffTool(baseOpts());
    const result = await tool.dispatch('some_other_tool', {});
    expect(result.ok).toBe(false);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('returns not-applicable when the baseline route 404s, without ever navigating to the target', async () => {
    const page = fakePage({ status: 404 });
    const browser = fakeBrowser(page);
    mockLaunch.mockResolvedValue(browser);

    const tool = new CaptureAndDiffTool(baseOpts());
    const result = await tool.dispatch('capture_and_diff', {});

    expect(result.ok).toBe(true);
    expect(result.text).toContain('VERDICT: not-applicable');
    expect(result.text).toContain('baseline');
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(baseOpts().baselineUrl, expect.any(Object));
    expect(browser.close).toHaveBeenCalled();
  });

  it('returns not-applicable when only the target 404s, after the baseline was reached', async () => {
    const page = fakePage();
    page.goto.mockResolvedValueOnce({ status: () => 200 }).mockResolvedValueOnce({ status: () => 404 });
    const browser = fakeBrowser(page);
    mockLaunch.mockResolvedValue(browser);

    const tool = new CaptureAndDiffTool(baseOpts());
    const result = await tool.dispatch('capture_and_diff', {});

    expect(result.text).toContain('VERDICT: not-applicable');
    expect(result.text).toContain('the baseline exists');
    expect(page.goto).toHaveBeenCalledTimes(2);
  });

  it('captures both pages full-page with masks applied, diffs them, and returns real stats plus three images', async () => {
    const page = fakePage();
    const browser = fakeBrowser(page);
    mockLaunch.mockResolvedValue(browser);

    const tool = new CaptureAndDiffTool({ ...baseOpts(), maskSelectors: ['.reader-count', '[data-testid="timestamp"]'] });
    const result = await tool.dispatch('capture_and_diff', {});

    expect(result.ok).toBe(true);
    expect(page.locator).toHaveBeenCalledWith('.reader-count');
    expect(page.locator).toHaveBeenCalledWith('[data-testid="timestamp"]');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true, type: 'png' }));
    expect(mockPixelmatch).toHaveBeenCalled();
    expect(result.text).toContain('42 pixels');
    expect(result.images).toHaveLength(3);
    expect(result.images![0].label).toContain('Baseline');
    expect(result.images![1].label).toContain('Target');
    expect(result.images![2].label).toContain('Diff overlay');
    expect(result.data).toMatchObject({ diffPixelCount: 42 });
    expect(browser.close).toHaveBeenCalled();
  });

  it('pads mismatched full-page dimensions onto a shared canvas rather than throwing, and notes it in the report', async () => {
    mockPngSyncRead.mockReset();
    mockPngSyncRead.mockReturnValueOnce({ width: 10, height: 20, data: Buffer.alloc(10 * 20 * 4) });
    mockPngSyncRead.mockReturnValueOnce({ width: 10, height: 10, data: Buffer.alloc(10 * 10 * 4) });
    const page = fakePage();
    const browser = fakeBrowser(page);
    mockLaunch.mockResolvedValue(browser);

    const tool = new CaptureAndDiffTool(baseOpts());
    const result = await tool.dispatch('capture_and_diff', {});

    expect(result.ok).toBe(true);
    expect(result.text).toContain('different full-page dimensions');
    expect(mockPixelmatch).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 10, 20, expect.anything());
  });

  it('closes the browser even when screenshot capture throws', async () => {
    const page = fakePage();
    page.screenshot.mockRejectedValue(new Error('boom'));
    const browser = fakeBrowser(page);
    mockLaunch.mockResolvedValue(browser);

    const tool = new CaptureAndDiffTool(baseOpts());
    await expect(tool.dispatch('capture_and_diff', {})).rejects.toThrow('boom');
    expect(browser.close).toHaveBeenCalled();
  });

  it('passes storageStatePath through to newContext when given', async () => {
    const page = fakePage();
    const browser = fakeBrowser(page);
    mockLaunch.mockResolvedValue(browser);

    const tool = new CaptureAndDiffTool({ ...baseOpts(), storageStatePath: '/tmp/auth.json' });
    await tool.dispatch('capture_and_diff', {});

    expect(browser.newContext).toHaveBeenCalledWith({ storageState: '/tmp/auth.json' });
  });

  it('passes an empty context config when no storageStatePath is given', async () => {
    const page = fakePage();
    const browser = fakeBrowser(page);
    mockLaunch.mockResolvedValue(browser);

    const tool = new CaptureAndDiffTool(baseOpts());
    await tool.dispatch('capture_and_diff', {});

    expect(browser.newContext).toHaveBeenCalledWith({});
  });
});
