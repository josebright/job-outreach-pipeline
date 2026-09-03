// tests/mail-provider.test.js
// Provider detection + interpretVerifierStatus. The critical case is
// accept_all on Google Workspace / M365 / Cloudflare — Hunter reports
// accept_all because those providers block RCPT TO verification, and
// our old code discarded legit small-startup emails as a result.
import { describe, it, expect } from 'vitest';
import { detectMailProvider, interpretVerifierStatus } from '../src/pipeline/enrich/mail-provider.js';

function fakeResolver(map) {
  return {
    async resolveMx(host) {
      if (map[host]) return map[host];
      const err = new Error('ENODATA'); err.code = 'ENODATA'; throw err;
    },
  };
}

describe('detectMailProvider', () => {
  it('detects Google Workspace from ASPMX exchange', async () => {
    const r = fakeResolver({
      'x.com': [
        { exchange: 'aspmx.l.google.com', priority: 1 },
        { exchange: 'alt1.aspmx.l.google.com', priority: 5 },
      ],
    });
    expect(await detectMailProvider('x.com', { resolver: r })).toBe('google');
  });

  it('detects Google Workspace from googlemail.com exchange', async () => {
    const r = fakeResolver({
      'x.com': [{ exchange: 'gmr-smtp-in.l.googlemail.com', priority: 5 }],
    });
    expect(await detectMailProvider('x.com', { resolver: r })).toBe('google');
  });

  it('detects Microsoft 365 from outlook.com exchange', async () => {
    const r = fakeResolver({
      'x.com': [{ exchange: 'x-com.mail.protection.outlook.com', priority: 0 }],
    });
    expect(await detectMailProvider('x.com', { resolver: r })).toBe('microsoft');
  });

  it('detects Cloudflare Email Routing', async () => {
    const r = fakeResolver({
      'x.com': [
        { exchange: 'route1.mx.cloudflare.net', priority: 1 },
        { exchange: 'route2.mx.cloudflare.net', priority: 2 },
      ],
    });
    expect(await detectMailProvider('x.com', { resolver: r })).toBe('cloudflare');
  });

  it('detects Zoho', async () => {
    const r = fakeResolver({
      'x.com': [{ exchange: 'mx.zoho.com', priority: 10 }],
    });
    expect(await detectMailProvider('x.com', { resolver: r })).toBe('zoho');
  });

  it('returns "other" for custom / unknown mail servers', async () => {
    const r = fakeResolver({
      'x.com': [{ exchange: 'mail.somebusiness.io', priority: 10 }],
    });
    expect(await detectMailProvider('x.com', { resolver: r })).toBe('other');
  });

  it('returns "none" when the domain has no MX records', async () => {
    const r = fakeResolver({});
    expect(await detectMailProvider('nomx.example', { resolver: r })).toBe('none');
  });
});

describe('interpretVerifierStatus', () => {
  it('maps deliverable/valid to verified for all providers', () => {
    for (const p of ['google', 'microsoft', 'cloudflare', 'zoho', 'other']) {
      expect(interpretVerifierStatus('deliverable', p)).toBe('verified');
      expect(interpretVerifierStatus('valid', p)).toBe('verified');
    }
  });

  it('maps undeliverable to invalid for all providers', () => {
    for (const p of ['google', 'microsoft', 'other']) {
      expect(interpretVerifierStatus('undeliverable', p)).toBe('invalid');
    }
  });

  it('maps disposable to invalid for all providers', () => {
    expect(interpretVerifierStatus('disposable', 'google')).toBe('invalid');
  });

  it('accept_all on Google is downgraded from invalid to risky', () => {
    expect(interpretVerifierStatus('accept_all', 'google')).toBe('risky');
  });

  it('accept_all on Microsoft is downgraded to risky', () => {
    expect(interpretVerifierStatus('accept_all', 'microsoft')).toBe('risky');
  });

  it('accept_all on Cloudflare is downgraded to risky', () => {
    expect(interpretVerifierStatus('accept_all', 'cloudflare')).toBe('risky');
  });

  it('accept_all on unknown provider stays invalid (real catch-all risk)', () => {
    expect(interpretVerifierStatus('accept_all', 'other')).toBe('invalid');
  });

  it('accept_all on Zoho stays invalid (Zoho answers RCPT correctly, so this is real catch-all)', () => {
    expect(interpretVerifierStatus('accept_all', 'zoho')).toBe('invalid');
  });

  it('accept_all on other provider is downgraded to risky when personalCount >= 3', () => {
    expect(interpretVerifierStatus('accept_all', 'other', 3)).toBe('risky');
    expect(interpretVerifierStatus('accept_all', 'zoho', 5)).toBe('risky');
  });

  it('accept_all on other provider stays invalid when personalCount < 3', () => {
    expect(interpretVerifierStatus('accept_all', 'other', 2)).toBe('invalid');
    expect(interpretVerifierStatus('accept_all', 'other', 0)).toBe('invalid');
    expect(interpretVerifierStatus('accept_all', 'other', null)).toBe('invalid');
  });

  it('unknown / webmail / risky all normalize to risky', () => {
    for (const s of ['unknown', 'webmail', 'risky']) {
      expect(interpretVerifierStatus(s, 'google')).toBe('risky');
    }
  });
});
