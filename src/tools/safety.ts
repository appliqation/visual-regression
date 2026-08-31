// This agent's own domain knowledge of which appq tools it may touch — the
// enforcement mechanism (assertToolAllowed / the gated dispatcher) lives in
// @appliqation/agent-core, shared with every sibling agent; only the
// allowlist content is local. Zero write tools — genuinely absent, not
// gated behind a flag. This agent never calls an appq write tool; it only
// ever reports a verdict, never files a defect or persists anything.

export const READONLY_CONTEXT_TOOLS = new Set([
  // The test case's own expected_result/steps, when a --test-case-uuid was
  // given — the ground truth a diff's "is this expected" judgment gets
  // checked against. Optional context, not required to proceed.
  'get_scenario',
]);
