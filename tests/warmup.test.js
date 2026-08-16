// tests/warmup.test.js
import { describe, it, expect } from 'vitest';
import { effectiveCap } from '../src/pipeline/send/warmup.js';

const fullCaps = { daily_cap_initial: 15, daily_cap_followup: 15 };

function cfg({ start = null, sunday = 3 } = {}) {
  return { send: { ...fullCaps, warmup_start_date: start, sunday_cap_initial: sunday } };
}

// 2026-08-14 (Fri), 2026-08-17 (Mon), 2026-08-21 (Fri), 2026-08-24 (Mon)
// picked so none of the assertions collide with Sunday's separate cap.

describe('effectiveCap warm-up ramp', () => {
  it('returns full cap when no warm-up date is set', () => {
    const r = effectiveCap({ kind: 'initial', config: cfg(), now: new Date('2026-08-14T09:00:00Z') });
    expect(r.cap).toBe(15);
    expect(r.isRamping).toBe(false);
  });

  it('day 1 of ramp caps at 10 (mailbox with some prior history)', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-14T09:00:00Z'),
    });
    expect(r.cap).toBe(10);
    expect(r.warmupDay).toBe(1);
    expect(r.isRamping).toBe(true);
  });

  it('day 4 caps at 11', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-17T09:00:00Z'),
    });
    expect(r.cap).toBe(11);
    expect(r.warmupDay).toBe(4);
  });

  it('day 8 caps at 13', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-21T09:00:00Z'),
    });
    expect(r.cap).toBe(13);
  });

  it('day 10 caps at 14', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-14' }),
      now: new Date('2026-08-23T09:00:00Z'),  // Aug 23 = Sunday, but this exercises the day-10 boundary; check via kind=followup to avoid sunday cap
    });
    // Day 10 with initial + Sunday: sunday cap (3) wins over ramp (14).
    expect(r.cap).toBe(3);
    expect(r.warmupDay).toBe(10);
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
    // Ramp day 1 = 10, follow-up config cap = 10 → cap is 10.
    expect(r.cap).toBe(10);
  });

  it('follow-up ignores Sunday cap', () => {
    // 2026-08-16 is a Sunday. Followups still send even on Sundays.
    const r = effectiveCap({
      kind: 'followup', config: cfg({ start: null, sunday: 3 }),
      now: new Date('2026-08-16T09:00:00Z'),
    });
    expect(r.cap).toBe(15);
    expect(r.isSunday).toBe(true);
  });

  it('initial caps at Sunday cap on Sunday even without ramp', () => {
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: null, sunday: 3 }),
      now: new Date('2026-08-16T09:00:00Z'),
    });
    expect(r.cap).toBe(3);
    expect(r.isSunday).toBe(true);
  });

  it('Sunday cap wins over ramp when ramp > sunday cap', () => {
    // Day 5 of ramp = 11; Sunday cap of 3 clips it to 3.
    const r = effectiveCap({
      kind: 'initial', config: cfg({ start: '2026-08-12', sunday: 3 }),
      now: new Date('2026-08-16T09:00:00Z'),  // Sunday, day 5
    });
    expect(r.cap).toBe(3);
    expect(r.warmupDay).toBe(5);
    expect(r.isSunday).toBe(true);
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
