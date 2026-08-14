// db/event-log.js
// Append-only event log. Every state transition must go through here.
import { getDb } from './connection.js';

/**
 * Record a domain event.
 * @param {object} args
 * @param {string} args.entity  - company | job | contact | draft | message | system
 * @param {number|null} args.entityId
 * @param {string} args.event   - discovered | ingested | qualified | draft_created | approved | sent | bounced | replied | suppressed | error
 * @param {object} [args.detail]
 */
export function recordEvent({ entity, entityId = null, event, detail = null }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO event_log (entity, entity_id, event, detail_json)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(entity, entityId, event, detail ? JSON.stringify(detail) : null);
}

export function recentEvents({ entity = null, limit = 50 } = {}) {
  const db = getDb();
  if (entity) {
    return db.prepare(`
      SELECT * FROM event_log WHERE entity = ? ORDER BY at DESC LIMIT ?
    `).all(entity, limit);
  }
  return db.prepare(`
    SELECT * FROM event_log ORDER BY at DESC LIMIT ?
  `).all(limit);
}
