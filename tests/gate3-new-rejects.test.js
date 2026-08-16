// tests/gate3-new-rejects.test.js
// Coverage for the CIAM / secure-build / agent rejects added after the
// production leak of Affirm's "Senior CIAM Software Engineer", Docker's
// "Senior SWE, Secure Build" and Vercel's "Software Engineer, Agent".
import { describe, it, expect } from 'vitest';
import { gate3_skillsetMatch } from '../src/pipeline/qualify/filters.js';

const config = {
  stack: {
    keywords: ['software engineer', 'backend', 'node', 'python'],
    seniority_accept: ['senior'],
    seniority_reject: ['intern', 'junior'],
    junior_override_min_annual: 36000,
  },
  currency: { accept: ['USD', 'EUR', 'GBP'] },
};

describe('gate3_skillsetMatch: newly-added rejects', () => {
  it('rejects "Senior CIAM Software Engineer"', () => {
    const r = gate3_skillsetMatch({ title: 'Senior CIAM Software Engineer', description_text: 'Node' }, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('title_role_out_of_scope');
  });

  it('rejects "Customer Identity Software Engineer"', () => {
    const r = gate3_skillsetMatch({ title: 'Customer Identity Software Engineer', description_text: 'Node' }, config);
    expect(r.pass).toBe(false);
  });

  it('rejects "Senior Software Engineer, Secure Build"', () => {
    const r = gate3_skillsetMatch({ title: 'Senior Software Engineer, Secure Build', description_text: 'Node' }, config);
    expect(r.pass).toBe(false);
  });

  it('rejects "Software Engineer, Supply Chain Security"', () => {
    const r = gate3_skillsetMatch({ title: 'Software Engineer, Supply Chain Security', description_text: 'Node' }, config);
    expect(r.pass).toBe(false);
  });

  it('rejects "Software Engineer, Agent"', () => {
    const r = gate3_skillsetMatch({ title: 'Software Engineer, Agent', description_text: 'Node' }, config);
    expect(r.pass).toBe(false);
  });

  it('rejects "Software Engineer - Agent"', () => {
    const r = gate3_skillsetMatch({ title: 'Software Engineer - Agent', description_text: 'Node' }, config);
    expect(r.pass).toBe(false);
  });

  it('rejects "Agentic AI Engineer"', () => {
    const r = gate3_skillsetMatch({ title: 'Agentic AI Engineer', description_text: 'Node' }, config);
    expect(r.pass).toBe(false);
  });

  it('still accepts plain "Senior Software Engineer"', () => {
    const r = gate3_skillsetMatch({ title: 'Senior Software Engineer', description_text: 'Node' }, config);
    expect(r.pass).toBe(true);
  });
});
