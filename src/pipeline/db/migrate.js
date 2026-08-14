// db/migrate.js
// Applies .sql files from /migrations in filename order.
// Idempotent: tracks applied migrations in schema_migrations.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './connection.js';
import { logger } from '../util/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', 'migrations');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function runMigrations() {
  const db = getDb();
  ensureMigrationsTable(db);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    logger.warn({ dir: MIGRATIONS_DIR }, 'migrations directory missing');
    return { applied: [], skipped: [] };
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied = [];
  const skipped = [];

  const already = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map(r => r.filename)
  );

  for (const file of files) {
    if (already.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    });
    tx();
    applied.push(file);
    logger.info({ file }, 'migration applied');
  }

  return { applied, skipped };
}
