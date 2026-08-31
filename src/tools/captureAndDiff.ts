// The one real piece of new mechanism in this repo. Deliberately NOT driven
// by the model turn-by-turn (BROWSER_TOOL_DEFS is never offered) — the
// entire mechanical pipeline (navigate baseline, navigate target, mask,
// screenshot, pixel-diff) is one atomic, code-owned tool call. The model's
// only job, in the turn after this returns, is judgment: given the two real
// screenshots + a diff overlay + real diff stats, classify the result. This
// keeps the objective measurement itself (pixel counts, dimensions, the
// not-applicable determination) something the model can never quietly
// override with its own claim — same "never trust the model's own report"
// discipline every sibling agent applies to its own domain.

import { chromium, type Locator, type Page } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { LlmToolDef, LlmImage, ToolResult } from '@appliqation/agent-core';

export const CAPTURE_TOOL_DEFS: LlmToolDef[] = [
  {
    name: 'capture_and_diff',
    description:
      'Navigate to the same route on the baseline (production) and target environment, mask any ' +
      'configured dynamic regions, take full-page screenshots of both, and pixel-diff them. Takes no ' +
      'arguments — baseline URL, target URL, and mask selectors were already given when this run started. ' +
      'Call this exactly once. Returns the two real screenshots, a diff overlay image, and real diff ' +
      'statistics — or, if the route does not exist on the baseline environment, a pre-determined ' +
      'not-applicable result with no diff attempted.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export interface CaptureAndDiffOptions {
  baselineUrl: string;
  targetUrl: string;
  maskSelectors: string[];
  storageStatePath?: string;
}

interface DecodedPng {
  width: number;
  height: number;
  data: Buffer;
}

function decodePng(buffer: Buffer): DecodedPng {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * pixelmatch requires both inputs to be the exact same dimensions. Real
 * pages on two environments can legitimately differ in full-page height
 * (different content length, not a bug) — rather than fail, pad both onto a
 * shared canvas sized to the larger of the two, filling new area with a
 * fixed, obviously-synthetic color. The padded region then genuinely shows
 * up as 100% different in the diff, which is correct: a real dimension
 * mismatch is real information for the model to reason about, not something
 * to silently crop away.
 */
function padToMatch(a: DecodedPng, b: DecodedPng): { a: DecodedPng; b: DecodedPng } {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  if (width === a.width && height === a.height && width === b.width && height === b.height) {
    return { a, b };
  }
  const pad = (img: DecodedPng): DecodedPng => {
    const out = new PNG({ width, height });
    out.data.fill(0);
    for (let y = 0; y < img.height; y++) {
      img.data.copy(out.data, (y * width) * 4, y * img.width * 4, y * img.width * 4 + img.width * 4);
    }
    return { width, height, data: out.data };
  };
  return { a: pad(a), b: pad(b) };
}

function toLlmImage(buffer: Buffer, label: string): LlmImage {
  return { data: buffer.toString('base64'), mimeType: 'image/png', label };
}

async function captureFullPage(page: Page, url: string, maskSelectors: string[]): Promise<{ status: 'ok' | 'not-found'; httpStatus: number | null; png: Buffer | null }> {
  const response = await page.goto(url, { waitUntil: 'networkidle' }).catch(() => null);
  const httpStatus = response?.status() ?? null;
  if (httpStatus === 404) {
    return { status: 'not-found', httpStatus, png: null };
  }
  // Best-effort: let CSS transitions/animations settle before capture, same
  // reasoning every screenshot-diff tool needs — a mid-transition frame is
  // noise, not a real difference.
  await page.addStyleTag({ content: '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; }' }).catch(() => {});
  const mask: Locator[] = maskSelectors.map((selector) => page.locator(selector));
  const png = await page.screenshot({ fullPage: true, type: 'png', mask });
  return { status: 'ok', httpStatus, png };
}

export class CaptureAndDiffTool {
  constructor(private opts: CaptureAndDiffOptions) {}

  async dispatch(name: string, _args: Record<string, unknown>): Promise<ToolResult> {
    if (name !== 'capture_and_diff') {
      return { ok: false, text: `Unknown tool: ${name}` };
    }

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext(this.opts.storageStatePath ? { storageState: this.opts.storageStatePath } : {});
      const page = await context.newPage();

      const baseline = await captureFullPage(page, this.opts.baselineUrl, this.opts.maskSelectors);
      if (baseline.status === 'not-found') {
        return {
          ok: true,
          text:
            `VERDICT: not-applicable (predetermined by capture_and_diff, do not override this)\n` +
            `Reason: the baseline (production) URL ${this.opts.baselineUrl} returned HTTP 404 — this route ` +
            `does not exist on the baseline environment. No comparison is possible; the target environment ` +
            `was never navigated to.`,
        };
      }

      const target = await captureFullPage(page, this.opts.targetUrl, this.opts.maskSelectors);
      if (target.status === 'not-found') {
        return {
          ok: true,
          text:
            `VERDICT: not-applicable (predetermined by capture_and_diff, do not override this)\n` +
            `Reason: the baseline exists (HTTP ${baseline.httpStatus}) but the target URL ${this.opts.targetUrl} ` +
            `returned HTTP 404. No comparison is possible.`,
        };
      }

      const decodedBaseline = decodePng(baseline.png!);
      const decodedTarget = decodePng(target.png!);
      const { a: paddedBaseline, b: paddedTarget } = padToMatch(decodedBaseline, decodedTarget);

      const diffPng = new PNG({ width: paddedBaseline.width, height: paddedBaseline.height });
      const diffPixelCount = pixelmatch(paddedBaseline.data, paddedTarget.data, diffPng.data, paddedBaseline.width, paddedBaseline.height, { threshold: 0.1 });
      const totalPixels = paddedBaseline.width * paddedBaseline.height;
      const diffPercentage = totalPixels > 0 ? (diffPixelCount / totalPixels) * 100 : 0;
      const diffOverlayBuffer = PNG.sync.write(diffPng);

      const dimensionNote =
        decodedBaseline.width !== decodedTarget.width || decodedBaseline.height !== decodedTarget.height
          ? ` Note: baseline is ${decodedBaseline.width}x${decodedBaseline.height}, target is ` +
            `${decodedTarget.width}x${decodedTarget.height} — different full-page dimensions, padded onto a ` +
            `shared ${paddedBaseline.width}x${paddedBaseline.height} canvas before diffing. The padded region ` +
            `shows up as fully different in the overlay; that may just reflect different content length, not a ` +
            `layout break — reason about it accordingly.`
          : '';

      return {
        ok: true,
        text:
          `Baseline (production): ${this.opts.baselineUrl} (HTTP ${baseline.httpStatus})\n` +
          `Target: ${this.opts.targetUrl} (HTTP ${target.httpStatus})\n` +
          `Masked selectors: ${this.opts.maskSelectors.length > 0 ? this.opts.maskSelectors.join(', ') : '(none)'}\n` +
          `Real diff: ${diffPixelCount} pixels differ out of ${totalPixels} (${diffPercentage.toFixed(2)}%).${dimensionNote}\n` +
          `These numbers are real and code-computed — never restate a different figure.`,
        data: { diffPixelCount, diffPercentage, baselineHttpStatus: baseline.httpStatus, targetHttpStatus: target.httpStatus },
        images: [
          toLlmImage(baseline.png!, `Baseline (production) — ${this.opts.baselineUrl}`),
          toLlmImage(target.png!, `Target — ${this.opts.targetUrl}`),
          toLlmImage(diffOverlayBuffer, 'Diff overlay (magenta/highlighted = differs)'),
        ],
      };
    } finally {
      await browser.close();
    }
  }
}
