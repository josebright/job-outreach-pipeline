// draft/index.js
// Module 5 per PRD. LLM draft generation + hook_evidence verification.
// Full implementation lands in Week 5.
import { logger } from '../util/logger.js';

export async function runDraft({ config: _config } = {}) {
  logger.info('draft: not yet implemented (Week 5 milestone)');
  return { drafted: 0, hookFailed: 0 };
}

/**
 * Anti-hallucination gate: hook_evidence must appear verbatim (or near-verbatim
 * after whitespace normalization) in the source posting.
 * Used by tests today, wired into runDraft in Week 5.
 */
export function verifyHookEvidence({ hookEvidence, sourceText }) {
  if (!hookEvidence || !sourceText) return false;
  const norm = s => s.replace(/\s+/g, ' ').toLowerCase().trim();
  return norm(sourceText).includes(norm(hookEvidence));
}
