// db/connection.js
// Singleton better-sqlite3 handle. Foreign keys + WAL enabled.
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

const DEFAULT_DB_PATH = process.env.PIPELINE_DB_PATH
  || path.join(ROOT_DIR, 'data', 'pipeline.db');

let db = null;

export function getDb(dbPath = DEFAULT_DB_PATH) {
  if (db) return db;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

// Lets the issue log record into the database without being the thing that
// opens it - a warning logged before startup must not create data/pipeline.db.
export function isDbOpen() {
  return db !== null;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Reset for tests. Do not use in production paths.
export function _resetForTests(dbPath) {
  closeDb();
  if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return getDb(dbPath);
}
