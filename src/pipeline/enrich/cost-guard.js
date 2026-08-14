// enrich/cost-guard.js
// Persisted monthly budget per provider. Reads and increments cost_ledger.
// Bail before an API call if the ledger says we would exceed budget.
import { getDb } from '../db/connection.js';

function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Read current usage and configured budget for a provider this month.
 * Creates the row if missing.
 */
export function usage(provider, budget) {
  const db = getDb();
  const month = currentMonth();
  db.prepare(`
    INSERT INTO cost_ledger (month, provider, units, budget)
    VALUES (?, ?, 0, ?)
    ON CONFLICT (month, provider) DO UPDATE SET budget = ?
  `).run(month, provider, budget, budget);
  const row = db.prepare(
    'SELECT units, budget FROM cost_ledger WHERE month = ? AND provider = ?'
  ).get(month, provider);
  return { units: row.units, budget: row.budget, remaining: row.budget - row.units, month };
}

/**
 * Charge units against this month. Returns the new totals.
 * Throws BudgetExceededError if the charge would exceed budget.
 */
export function charge(provider, units, budget) {
  const before = usage(provider, budget);
  if (before.units + units > before.budget) {
    const err = new Error(`Budget exceeded for ${provider}: ${before.units}+${units} > ${before.budget}`);
    err.name = 'BudgetExceededError';
    err.provider = provider;
    err.budget = before.budget;
    err.used = before.units;
    err.wanted = units;
    throw err;
  }
  const db = getDb();
  db.prepare(`
    UPDATE cost_ledger SET units = units + ? WHERE month = ? AND provider = ?
  `).run(units, currentMonth(), provider);
  return usage(provider, budget);
}

export class BudgetExceededError extends Error {
  constructor(message) { super(message); this.name = 'BudgetExceededError'; }
}
