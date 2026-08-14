// discover/aggregators/index.js
// Registry of aggregator clients. Same pattern as ats/index.js.
import * as remotive from './remotive.js';
import * as remoteok from './remoteok.js';

const REGISTRY = {
  [remotive.source]: remotive,
  [remoteok.source]: remoteok,
};

export function getAggregator(name) {
  const client = REGISTRY[name];
  if (!client) throw new Error(`Unknown aggregator: ${name}`);
  return client;
}

export function listAggregators() { return Object.keys(REGISTRY); }
