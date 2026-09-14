// util/run-lock.js
// One process-wide lock per kind of work. The daily cron (scripts/service.js)
// and the Telegram /run command both drive the full pipeline, and each had its
// own idea of "already running": the cron kept a local flag, /run kept none.
// Two overlapping runs both see a company with no open draft and both draft
// it. The send side is worse - two overlapping send passes load the same
// approved draft and deliver it twice.
const held = new Map();   // name -> { since, holder }

export function lockInfo(name) {
  const t = held.get(name);
  return t ? { holder: t.holder, sinceSec: Math.round((Date.now() - t.since) / 1000) } : null;
}

/**
 * Run fn under the named lock. Returns { busy: true, info } without running fn
 * when the lock is already held, otherwise { busy: false, result }.
 */
export async function withLock(name, holder, fn) {
  if (held.has(name)) return { busy: true, info: lockInfo(name) };
  const token = { since: Date.now(), holder };
  held.set(name, token);
  try {
    return { busy: false, result: await fn() };
  } finally {
    if (held.get(name) === token) held.delete(name);
  }
}

export function _resetLocksForTests() { held.clear(); }
