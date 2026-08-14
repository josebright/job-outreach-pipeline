// ingest/ats/index.js
// Registry of ATS clients. Look up by name.
import * as greenhouse from './greenhouse.js';
import * as lever from './lever.js';
import * as ashby from './ashby.js';
import * as workable from './workable.js';

const REGISTRY = {
  [greenhouse.name]: greenhouse,
  [lever.name]: lever,
  [ashby.name]: ashby,
  [workable.name]: workable,
};

export function getAts(name) {
  const client = REGISTRY[name];
  if (!client) throw new Error(`Unknown ATS: ${name}`);
  return client;
}

export function listAts() { return Object.keys(REGISTRY); }
