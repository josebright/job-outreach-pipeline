// qualify/pay-check.js
// Gate 2 helper: decide whether a job's pay meets the priority-chain
// minimum. Salary extraction lives in salary.js; this file layers the
// gate's decision policy on top.
//
// Decision matrix (see qualify/index.js gate 2):
//   status === 'above_floor'    → pass
//   status === 'below_floor'    → fail
//   status === 'wrong_currency' → fail (posting quotes non-USD/EUR/GBP)
//   status === 'unstated'       → pass (user preference: don't reject
//                                 postings just for hiding the number)
import { extractAnnualSalary } from './salary.js';

const ACCEPTED = ['USD', 'EUR', 'GBP'];

/**
 * @param {object} args
 * @param {string|null} args.compRaw
 * @param {string|null} args.descriptionText
 * @param {number}      args.minAnnual - the floor from config.gates.pay_minimum_annual
 * @param {string[]}    [args.acceptedCurrencies=ACCEPTED]
 * @returns {{ status:'above_floor'|'below_floor'|'wrong_currency'|'unstated',
 *             annual:number|null, currency:string|null }}
 */
export function checkPay({ compRaw, descriptionText, minAnnual, acceptedCurrencies = ACCEPTED }) {
  // First try with our accepted currencies. Use a low noise floor so
  // legitimately-low quotes (e.g. "$1000/month" = $12k/yr) still register
  // as a stated salary rather than getting dropped as noise — otherwise
  // the gate can't tell "below floor" apart from "unstated".
  const found = extractAnnualSalary({
    compRaw, descriptionText, acceptedCurrencies,
    minPlausibleAnnual: 5000,
  });
  if (found) {
    if (found.annual >= minAnnual) {
      return { status: 'above_floor', annual: found.annual, currency: found.currency };
    }
    return { status: 'below_floor', annual: found.annual, currency: found.currency };
  }

  // No hit against USD/EUR/GBP. That could mean either:
  //   (a) truly no salary stated → 'unstated' (pass)
  //   (b) salary stated in a non-accepted currency (INR/BRL/ARS/etc.) → 'wrong_currency' (fail)
  // Distinguish by scanning for any currency-looking token.
  const hasOtherCurrency = detectNonAcceptedCurrency([compRaw, descriptionText]);
  if (hasOtherCurrency) {
    return { status: 'wrong_currency', annual: null, currency: hasOtherCurrency };
  }
  return { status: 'unstated', annual: null, currency: null };
}

// Detect any currency token that ISN'T USD/EUR/GBP. If found, the posting
// is quoting pay in a currency we don't accept, which fails the gate.
const NON_ACCEPTED_CURRENCY_RE =
  /\b(INR|BRL|ARS|MXN|CAD|AUD|NZD|JPY|CNY|SGD|HKD|ZAR|NGN|KES|GHS|PLN|CZK|HUF|RON|TRY|RUB|UAH)\b|₹|R\$|A\$|C\$|¥|₩|₦/i;

function detectNonAcceptedCurrency(texts) {
  for (const t of texts) {
    if (!t) continue;
    const m = String(t).match(NON_ACCEPTED_CURRENCY_RE);
    if (m) return m[0].toUpperCase();
  }
  return null;
}
