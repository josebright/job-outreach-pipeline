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
    company_size_sweet_spot: z.number().default(10),
    eor_mention: z.number().default(5),
  }),
});

const sendSchema = z.object({
  domain: z.string(),
  sender_email: z.string().email(),
  sender_name: z.string(),
  reply_to: z.string().email().optional(),
  daily_cap_initial: z.number().int().positive().default(15),
  daily_cap_followup: z.number().int().positive().default(15),
  send_window_local_start: z.string().default('08:30'),
  send_window_local_end: z.string().default('11:00'),
  bounce_rate_alarm_pct: z.number().default(3),
});

const enrichmentSchema = z.object({
  providers: z.array(z.enum(['hunter', 'apollo', 'snov', 'proxycurl'])).min(1),
  monthly_budget_usd: z.number().nonnegative().default(50),
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
  serp_provider: z.enum(['serper', 'serpapi', 'google_pse']).default('serper'),
  monthly_query_budget: z.number().int().positive().default(500),
  ats_platforms: z.array(z.enum(['greenhouse', 'lever', 'ashby', 'workable'])).default([
    'greenhouse', 'lever', 'ashby', 'workable',
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
