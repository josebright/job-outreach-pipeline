// send/warmup.js
// Cold-mailbox warm-up ramp + Sunday-specific cap.
//
// Ramp schedule for a mailbox that has some send history but is not
// regular at outreach volume. Start at 10, reach full cap by day 11.
//
//   Days  1- 2: 10/day
//   Days  3- 5: 11/day
//   Days  6- 7: 12/day
//   Days  8- 9: 13/day
//   Day  10:    14/day
//   Day  11+:   full cap (default 15)
//
// Configured by send.warmup_start_date (ISO date). If unset, no ramp is
// applied (mailbox is treated as fully warmed).
//
// Sunday override: independent of the ramp, cold outreach on Sundays is
// low-signal and spam-prone (Gmail penalizes weekend blasters). Cap
// initial sends to config.send.sunday_cap_initial regardless of ramp day.
// Follow-ups are unaffected — replying to an existing thread is not the
// same signal to mailbox providers.

const RAMP = [
  { untilDay:  2, cap: 10 },
  { untilDay:  5, cap: 11 },
  { untilDay:  7, cap: 12 },
  { untilDay:  9, cap: 13 },
  { untilDay: 10, cap: 14 },
  // day 11+ → full cap (caller's config value)
];

/**
 * Returns the effective daily cap for a given kind ('initial' | 'followup').
 * @param {object} args
 * @param {string} args.kind
 * @param {object} args.config
 * @param {Date} [args.now] - defaults to new Date()
 * @returns {{ cap:number, warmupDay:number|null, isRamping:boolean, isSunday:boolean }}
 */
export function effectiveCap({ kind, config, now = new Date() }) {
  const fullCap = kind === 'initial'
    ? config.send.daily_cap_initial
    : config.send.daily_cap_followup;

  // Sunday cap applies to initial sends only, and only when configured.
  // WAT (Africa/Lagos) is UTC+1 year-round, so shift by +1h to get the
  // local day-of-week. Simpler than pulling a tz lib for one lookup.
  const watOffsetMs = 1 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + watOffsetMs);
  const isSunday = local.getUTCDay() === 0;

  const startIso = config.send.warmup_start_date;
  let rampCap = fullCap;
  let warmupDay = null;
  let isRamping = false;

  if (startIso) {
    const start = new Date(`${startIso}T00:00:00Z`);
    if (!Number.isNaN(start.getTime())) {
      const days = Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
      warmupDay = days;
      if (days <= 0) {
        rampCap = 0;
        isRamping = true;
      } else {
        for (const step of RAMP) {
          if (days <= step.untilDay) {
            rampCap = Math.min(step.cap, fullCap);
            isRamping = true;
            break;
          }
        }
      }
    }
  }

  let cap = rampCap;
  if (kind === 'initial' && isSunday) {
    const sundayCap = Number(config.send.sunday_cap_initial ?? 0);
    cap = Math.min(cap, sundayCap);
  }

  return { cap, warmupDay, isRamping, isSunday };
}
