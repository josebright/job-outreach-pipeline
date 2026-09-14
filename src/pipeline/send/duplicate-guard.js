// send/duplicate-guard.js
// "Have we already applied here?" - asked the same way at draft time, at send
// time, and by the manual /draft command.
//
// The guards that already existed (gate5's 90-day rule, one open draft per
// company) all key on the company ROW. Companies are only unique by
// (ats, slug) and contacts by (company, email), so one real company reached
// through two sources becomes two rows - the live queue once held the same
// address, founders@api.smartrecruiters.com, under both Cint and ServiceNow -
// and every per-row guard would wave a second application through. These
// checks key on the address and its mail domain instead: what the recipient
// actually sees.
import {
  RECONTACT_DAYS, lastSentDraftTo, lastSentDraftToDomain, openDraftToAddressOrDomain,
} from '../db/repo.js';
import { emailDomainOf, isFreeMailDomain } from '../util/email-domain.js';

const day = (s) => String(s || '').slice(0, 10) || 'an earlier date';

/**
 * @param {object} args
 * @param {string} args.email
 * @param {boolean} [args.includeOpenDrafts] also treat a waiting draft as taken (draft time)
 * @param {number|null} [args.excludeDraftId]
 * @returns {null | { code: string, message: string, draftId: number }}
 */
export function duplicateApplicationReason({
  email, includeOpenDrafts = false, excludeDraftId = null, days = RECONTACT_DAYS,
}) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return null;
  const domain = emailDomainOf(address);
  // Two different people at gmail.com are not the same company.
  const companyDomain = domain && !isFreeMailDomain(domain) ? domain : null;

  const sameAddress = lastSentDraftTo(address, days);
  if (sameAddress) {
    return {
      code: 'already_applied_address',
      draftId: sameAddress.draft_id,
      message: `already applied to ${address} on ${day(sameAddress.sent_at)} (draft #${sameAddress.draft_id}, ${sameAddress.company})`,
    };
  }

  if (companyDomain) {
    const sameDomain = lastSentDraftToDomain(companyDomain, days);
    if (sameDomain) {
      return {
        code: 'already_applied_domain',
        draftId: sameDomain.draft_id,
        message: `already applied to ${sameDomain.email} at ${companyDomain} on ${day(sameDomain.sent_at)} (draft #${sameDomain.draft_id}, ${sameDomain.company})`,
      };
    }
  }

  if (includeOpenDrafts) {
    const open = openDraftToAddressOrDomain({ email: address, domain: companyDomain, excludeDraftId });
    if (open) {
      return {
        code: 'open_draft_same_recipient',
        draftId: open.draft_id,
        message: `draft #${open.draft_id} to ${open.email} (${open.company}) is already waiting for review`,
      };
    }
  }
  return null;
}
