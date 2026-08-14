// draft/hook-verify.js
// Anti-hallucination gate. hook_evidence returned by the LLM must appear
// verbatim (or near-verbatim after whitespace normalization) in the source
// job posting. Called before persisting each draft.
export function verifyHookEvidence({ hookEvidence, sourceText }) {
  if (!hookEvidence || !sourceText) return false;
  const norm = s => s.replace(/\s+/g, ' ').toLowerCase().trim();
  return norm(sourceText).includes(norm(hookEvidence));
}
