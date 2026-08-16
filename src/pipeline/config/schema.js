// config/schema.js
// Zod schema for config.yaml. Fail loud on drift.
import { z } from 'zod';

const trackSchema = z.enum(['A', 'B']);

const stackSchema = z.object({
  keywords: z.array(z.string()).min(1),
  seniority_accept: z.array(z.string()).min(1),
  seniority_reject: z.array(z.string()).default([]),
  // If a rejected-seniority role has an explicit annual salary at or above
  // this number (in any accepted currency), accept it anyway. Set to 0 to
  // disable the override.
  junior_override_min_annual: z.number().nonnegative().default(0),
});

const locationSchema = z.object({
  allow: z.array(z.string()).min(1),
  deny: z.array(z.string()).default([]),
});

const currencySchema = z.object({
  accept: z.array(z.enum(['USD', 'EUR', 'GBP'])).min(1),
  hq_country_currency_map: z.record(z.string(), z.string()).default({}),
  contractor_signal_words: z.array(z.string()).default([]),
});

const scoringSchema = z.object({
  threshold: z.number().int().min(0).max(100).default(40),
  weights: z.object({
    nigeria_presence: z.number().default(30),
    explicit_salary: z.number().default(15),
    remote_worldwide: z.number().default(15),
    recent_post_days: z.number().default(15),
    stack_overlap: z.number().default(10),
    company_size_sweet_spot: z.number().default(20),   // was 10; boosted for small startups
    seed_stage_bonus: z.number().default(5),           // extra for 11-50 (founder-read email)
    eor_mention: z.number().default(5),
  }),
  // Hard filter: companies at or above this size band are dropped after
  // scoring (Q6). Enterprise recruiting funnels through ATS + agencies
  // and does not respond to direct outreach at meaningful rates.
  // Hard ceiling: 500 employees. Anything at or above 501 is dropped in Q6.
  reject_size_bands: z.array(z.string()).default(['501-1000', '1000+', '10000+', '5001-10000']),
});

const sendSchema = z.object({
  domain: z.string(),
  sender_email: z.string().email(),
  sender_name: z.string(),
  reply_to: z.string().email().optional(),
  daily_cap_initial: z.number().int().positive().default(15),
  daily_cap_followup: z.number().int().positive().default(15),
  // Sunday is a low-signal day for cold outreach (replies dry up, Gmail
  // penalizes weekend blasters). Cap independently.
  sunday_cap_initial: z.number().int().nonnegative().default(3),
  // Research roles (Research Engineer / Applied Research Engineer / ML
  // Research Engineer) get their own daily send bucket so they do not
  // eat the primary engineering send budget.
  research_daily_cap: z.number().int().nonnegative().default(2),
  send_window_local_start: z.string().default('08:30'),
  send_window_local_end: z.string().default('11:00'),
  bounce_rate_alarm_pct: z.number().default(3),
  // Cold-mailbox warm-up. If set to an ISO date (YYYY-MM-DD), the send loop
  // caps daily volume on a 10-day ramp starting that date. Leave blank/null
  // to disable when the mailbox is already warmed.
  warmup_start_date: z.string().nullable().optional(),
});

const enrichmentSchema = z.object({
  providers: z.array(z.enum(['hunter', 'apollo', 'snov', 'proxycurl'])).min(1),
  // Monthly credit budget per provider (1 credit = 1 Hunter API call in most cases).
  // Hunter free tier = 50, Starter = 2000. Was named monthly_budget_usd; kept
  // that alias for backward compatibility.
  monthly_budget: z.number().nonnegative().default(2000),
  monthly_budget_usd: z.number().nonnegative().optional(),
  min_email_status_for_auto_send: z.enum(['verified', 'risky']).default('verified'),
});

const llmSchema = z.object({
  drafts_provider: z.enum(['anthropic', 'gemini']).default('anthropic'),
  drafts_model: z.string().default('claude-sonnet-4-6'),
  classifier_provider: z.enum(['anthropic', 'gemini']).default('gemini'),
  classifier_model: z.string().default('gemini-2.0-flash'),
  prompt_version: z.string().default('outreach_v1'),
});

const discoverSchema = z.object({
  serp_provider: z.enum(['brave', 'serper', 'serpapi', 'google_pse']).default('brave'),
  monthly_query_budget: z.number().int().positive().default(500),
  ats_platforms: z.array(z.enum(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters'])).default([
    'greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters',
  ]),
  aggregator_feeds: z.array(z.enum(['remotive', 'remoteok', 'wwr'])).default([
    'remotive', 'remoteok',
  ]),
  seed_csv_path: z.string().optional(),
});

export const configSchema = z.object({
  tracks_enabled: z.array(trackSchema).min(1).default(['A']),
  stack: stackSchema,
  location: locationSchema,
  currency: currencySchema,
  scoring: scoringSchema,
  discover: discoverSchema,
  enrichment: enrichmentSchema,
  llm: llmSchema,
  send: sendSchema,
});

export function parseConfig(raw) {
  return configSchema.parse(raw);
}
