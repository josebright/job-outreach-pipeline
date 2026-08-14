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

  it('day 1 of ramp caps at 2', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-14T09:00:00Z'),
    });
    expect(r.cap).toBe(2);
    expect(r.warmupDay).toBe(1);
    expect(r.isRamping).toBe(true);
  });

  it('day 3 caps at 3', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-16T09:00:00Z'),
    });
    expect(r.cap).toBe(3);
    expect(r.warmupDay).toBe(3);
  });

  it('day 10 caps at 9', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-23T09:00:00Z'),
    });
    expect(r.cap).toBe(9);
  });

  it('day 14+ returns full cap', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-28T09:00:00Z'),
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
    expect(r.cap).toBe(2); // still ramping, capped by ramp
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
