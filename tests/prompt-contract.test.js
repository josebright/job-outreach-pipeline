// tests/prompt-contract.test.js
// Pins the draft prompt against the code that feeds it. These drifted before:
// the tool schema capped the subject at 55 chars while the prompt asked for 60,
// and the variant names in variant.js have to match the ones the prompt defines
// or the model gets handed a variant it was never told how to write.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { loadSystemPrompt, DRAFT_TOOL } from '../src/pipeline/draft/llm.js';
import { pickDraftVariant } from '../src/pipeline/draft/variant.js';
import { parseConfig } from '../src/pipeline/config/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const activeVersion = () =>
  parseConfig(yaml.load(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'))).llm.prompt_version;

describe('active draft prompt', () => {
  const prompt = loadSystemPrompt(activeVersion());

  it('is the candidate-voice prompt', () => {
    expect(activeVersion()).toBe('outreach_v3');
  });

  it('covers every variant pickDraftVariant can emit', () => {
    const emitted = new Set();
    for (let i = 0; i < 200; i++) {
      emitted.add(pickDraftVariant(`co-${i}`, '11-50'));
      emitted.add(pickDraftVariant(`co-${i}`, '201-500'));
      emitted.add(pickDraftVariant(`co-${i}`, null));
    }
    expect(emitted.size).toBeGreaterThan(1);
    for (const v of emitted) expect(prompt, `prompt must define ${v}`).toContain(v);
  });

  it('does not still describe the retired consultant-voice variants', () => {
    // V2_QUESTION produced "Is the {role} hire for {team}?" subjects.
    expect(prompt).not.toContain('V2_QUESTION');
    expect(prompt).not.toContain('V1_OBSERVATION');
  });

  it('agrees with the tool schema on the subject length cap', () => {
    const cap = DRAFT_TOOL.input_schema.properties.subject.maxLength;
    expect(cap).toBe(60);
    expect(prompt).toContain(`<= ${cap} characters`);
  });

  it('requires the sender to say they are applying', () => {
    expect(prompt).toContain('MANDATORY APPLICATION SENTENCE');
    expect(prompt).toMatch(/I'd like to apply for the \{job_title\} role/);
  });

  it('requires two distinct pieces of evidence', () => {
    expect(prompt).toContain('TWO PIECES OF EVIDENCE, NOT ONE');
    expect(prompt).toMatch(/two different dimensions/i);
  });

  it('bans the consultant register that caused the rewrite', () => {
    for (const phrase of ['work sample', "if it's the angle", 'worth 15 min', 'Deel', 'Remote.com']) {
      expect(prompt, `should ban "${phrase}"`).toContain(phrase);
    }
    expect(prompt).toContain('CONSULTANT REGISTER - BANNED');
  });

  it('keeps the anti-hallucination floor', () => {
    expect(prompt).toContain('hook_evidence must appear verbatim');
    expect(prompt).toContain('SKIP: no verifiable hook');
  });
});

describe('profile feeds the prompt what it asks for', () => {
  const profile = yaml.load(fs.readFileSync(path.join(ROOT, 'data', 'profile.yaml'), 'utf8'));

  it('has enough achievements to cite two distinct ones', () => {
    expect(profile.achievements.length).toBeGreaterThanOrEqual(4);
  });

  it('exposes both signature links the prompt requires', () => {
    expect(profile.links.website).toBeTruthy();
    expect(profile.links.linkedin).toBeTruthy();
  });

  it('tells the model how to handle the unusable "security posture" metric', () => {
    // profile.yaml carries "raised the cloud security posture 60%", which the
    // prompt itself lists as a confabulation tell. The prompt must say to cite
    // the concrete actions instead of skipping an otherwise strong achievement.
    const hasQualitativePct = profile.achievements.some(a => /security posture .*60%/i.test(a));
    if (hasQualitativePct) {
      const prompt = loadSystemPrompt(activeVersion());
      expect(prompt).toMatch(/raised the cloud security posture 60%/i);
      expect(prompt).toMatch(/cite the concrete actions/i);
    }
  });
});
