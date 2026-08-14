// discover/aggregators/interface.js
// Every aggregator client returns Array<AggregatedCompany>.
//
// AggregatedCompany shape:
//   {
//     companyName,             // display name, used for slug resolution
//     url,                     // apply/canonical URL (may hint at the ATS)
//     source,                  // 'remotive' | 'remoteok' | 'wwr'
//     hint,                    // { ats?, slug? } optional pre-extracted ATS info
//                              // parsed from the URL when possible
//   }
