import 'dotenv/config';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '@appliqation/agent-core/providers';
import { required, optional } from '@appliqation/agent-core/config';
import { resolveAuditSink } from '@appliqation/agent-core/audit';

export const config = {
  appqOrigin: optional('APPQ_ORIGIN') ?? 'https://appq.appliqation.io',
  appqApiKey: () => required('APPQ_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),
  anthropicModel: optional('ANTHROPIC_MODEL'),
  openaiModel: optional('OPENAI_MODEL'),
  anthropicMaxTokens: Number(optional('ANTHROPIC_MAX_TOKENS') ?? 8192),
  openaiMaxOutputTokens: Number(optional('OPENAI_MAX_OUTPUT_TOKENS') ?? 8192),
  // One capture-then-judge pass — the mechanical work (two navigations, one
  // diff) is fixed cost; the model's only real work is a single judgment
  // call, so this budget is deliberately tight compared to heal-selector's.
  budget: {
    maxCalls: Number(optional('BUDGET_MAX_CALLS') ?? 15),
    // Two real navigations (baseline + target) happen inside the one
    // capture_and_diff tool call, not as separate browser_navigate calls —
    // this cap is a backstop, not something the model spends turn-by-turn.
    maxPages: Number(optional('BUDGET_MAX_PAGES') ?? 10),
    maxMillis: Number(optional('BUDGET_MAX_MILLIS') ?? 5 * 60 * 1000),
    maxTurns: Number(optional('BUDGET_MAX_TURNS') ?? 10),
    // A broad backstop against runaway spend, not a tuned budget. Includes
    // cache tokens — and matters more here than most siblings, since every
    // turn after capture_and_diff carries three real images in context.
    maxTotalTokens: Number(optional('BUDGET_MAX_TOTAL_TOKENS') ?? 1_000_000),
  },
  // Playwright browser tools' evidence ring-buffer cap — see
  // @appliqation/agent-core's evidence/capture.ts. Unused in practice: this
  // agent never exposes BROWSER_TOOL_DEFS to the model, capture_and_diff
  // drives its own browser directly. Kept for config-shape consistency with
  // every sibling agent.
  ringBufferCap: Number(optional('RING_BUFFER_CAP') ?? 10),

  // Observability, entirely opt-in — see @appliqation/agent-core's audit/sink.ts.
  auditSink: resolveAuditSink({
    auditMongoUri: optional('AUDIT_MONGO_URI'),
    auditMongoDb: optional('AUDIT_MONGO_DB'),
    auditMongoCollection: optional('AUDIT_MONGO_COLLECTION'),
    auditJsonlPath: optional('AUDIT_JSONL_PATH'),
  }),
};

export function resolveProvider(): 'anthropic' | 'openai' {
  if (config.anthropicApiKey) return 'anthropic';
  if (config.openaiApiKey) return 'openai';
  throw new Error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY');
}

export function resolveModel(): string {
  const provider = resolveProvider();
  return provider === 'anthropic' ? (config.anthropicModel ?? DEFAULT_ANTHROPIC_MODEL) : (config.openaiModel ?? DEFAULT_OPENAI_MODEL);
}
