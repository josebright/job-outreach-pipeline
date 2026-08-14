// tests/warmup.test.js
import { describe, it, expect } from 'vitest';
import { effectiveCap } from '../src/pipeline/send/warmup.js';

const fullCaps = { daily_cap_initial: 15, daily_cap_followup: 15 };

function cfg({ start = null } = {}) {
  return { send: { ...fullCaps, warmup_start_date: start } };
}

describe('effectiveCap warm-up ramp', () => {
  it('returns full cap when no warm-up date is set', () => {
    const r = effectiveCap({ kind: 'initial', config: cfg(), now: new Date('2026-08-14T09:00:00Z') });
    expect(r.cap).toBe(15);
    expect(r.isRamping).toBe(false);
  });

  it('day 1 of ramp caps at 5 (mailbox with some prior history)', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-14T09:00:00Z'),
    });
    expect(r.cap).toBe(5);
    expect(r.warmupDay).toBe(1);
    expect(r.isRamping).toBe(true);
  });

  it('day 4 caps at 7', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-17T09:00:00Z'),
    });
    expect(r.cap).toBe(7);
    expect(r.warmupDay).toBe(4);
  });

  it('day 8 caps at 13', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-21T09:00:00Z'),
    });
    expect(r.cap).toBe(13);
  });

  it('day 11+ returns full cap', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-24T09:00:00Z'),
    });
    expect(r.cap).toBe(15);
    expect(r.isRamping).toBe(false);
  });

  it('respects follow-up daily cap separately', () => {
    const c = cfg({ start: '2026-08-14' });
    c.send.daily_cap_followup = 10;
    const r = effectiveCap({
      kind: 'followup', config: c,
      now: new Date('2026-08-14T09:00:00Z'),
    });
    expect(r.cap).toBe(5); // still ramping, capped by ramp
  });

  it('ignores invalid start date and returns full cap', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: 'not-a-date' }),
      now: new Date('2026-08-14T09:00:00Z'),
    });
    expect(r.cap).toBe(15);
    expect(r.isRamping).toBe(false);
  });
});
