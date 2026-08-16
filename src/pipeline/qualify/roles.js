// qualify/roles.js
// Role classification helpers used by the send loop to route jobs into
// separate volume buckets. Research Engineer / Applied Research Engineer /
// Research Software Engineer are a low-volume, high-signal side channel
// that we want to send to *in addition to* the primary engineering cap,
// not out of it. See config.send.research_daily_cap.

const RESEARCH_MARKERS = [
  'research engineer',
  'research software engineer',
  'applied research engineer',
  'ml research engineer',
  'ai research engineer',
  'research scientist engineer',
];

export function isResearchRole(title) {
  const t = String(title || '').toLowerCase();
  return RESEARCH_MARKERS.some(m => t.includes(m));
}
