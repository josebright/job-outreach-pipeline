// send/warmup.js
// Cold-mailbox warm-up ramp. When a mailbox has never sent cold outreach at
// volume, jumping straight to 15/day trips volume-anomaly detectors even on
// a mature domain. Ramp gradually over ~14 days.
//
// Ramp schedule per PRD-style deliverability practice:
//   Days  1- 2:  2/day
//   Days  3- 4:  3/day
//   Days  5- 6:  5/day
//   Days  7- 8:  7/day
//   Days  9-10:  9/day
//   Days 11-13: 12/day
//   Day  14+:   full cap
//
// Configured by send.warmup_start_date (ISO date). If unset, no ramp is
// applied (mailbox is treated as fully warmed).

const RAMP = [
  { untilDay:  2, cap:  2 },
  { untilDay:  4, cap:  3 },
  { untilDay:  6, cap:  5 },
  { untilDay:  8, cap:  7 },
  { untilDay: 10, cap:  9 },
  { untilDay: 13, cap: 12 },
  // day 14+ → full cap (caller's config value)
];

/**
 * Returns the effective daily cap for a given kind ('initial' | 'followup').
 * @param {object} args
 * @param {string} args.kind
 * @param {object} args.config
 * @param {Date} [args.now] - defaults to new Date()
 * @returns {{ cap:number, warmupDay:number|null, isRamping:boolean }}
 */
export function effectiveCap({ kind, config, now = new Date() }) {
  const fullCap = kind === 'initial'
    ? config.send.daily_cap_initial
    : config.send.daily_cap_followup;

  const startIso = config.send.warmup_start_date;
  if (!startIso) return { cap: fullCap, warmupDay: null, isRamping: false };

  const start = new Date(`${startIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return { cap: fullCap, warmupDay: null, isRamping: false };

  const days = Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;

  if (days <= 0) return { cap: 0, warmupDay: days, isRamping: true };

  for (const step of RAMP) {
    if (days <= step.untilDay) {
      return { cap: Math.min(step.cap, fullCap), warmupDay: days, isRamping: true };
    }
  }
  return { cap: fullCap, warmupDay: days, isRamping: false };
}
