// ingest/ats/interface.js
// Contract every ATS client must satisfy.
//
// Each client exports:
//   name           - string, matches company.ats column
//   discoveryHost  - hostname used in Google dorks (e.g., 'boards.greenhouse.io')
//   probe(slug)    - async: returns { alive: boolean, companyName?: string }
//                    used by discovery to validate a slug before storing
//   fetchJobs(slug) - async: returns Array<NormalizedJob>
//
// NormalizedJob shape (returned to ingest layer):
//   {
//     externalJobId,       // provider's stable id
//     title,
//     department,          // nullable
//     locationRaw,         // nullable, raw string as posted
//     workplaceType,       // 'remote' | 'hybrid' | 'onsite' | 'unknown'
//     remoteScope,         // 'worldwide' | 'emea' | 'africa' | 'us_only' | 'onsite' | 'unknown'
//     currencySignal,      // 'USD' | 'EUR' | 'GBP' | null
//     compRaw,             // nullable, raw comp string if provider gave one
//     descriptionText,     // plain text, HTML stripped
//     url,                 // apply/canonical URL
//     postedAt,            // ISO string or null
//     updatedAtSource,     // ISO string or null
//   }

export function makeUnknownJob(overrides = {}) {
  return {
    externalJobId: null,
    title: null,
    department: null,
    locationRaw: null,
    workplaceType: 'unknown',
    remoteScope: 'unknown',
    currencySignal: null,
    compRaw: null,
    descriptionText: null,
    url: null,
    postedAt: null,
    updatedAtSource: null,
    ...overrides,
  };
}
