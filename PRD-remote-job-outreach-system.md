# PRD — Remote Job Outreach System ("Pipeline")

**Version:** 1.0
**Owner:** [Your name] — Senior Software Engineer, Nigeria
**Status:** Approved for build
**Last updated:** August 2026

---

## 1. Problem Statement

A senior software engineer based in Nigeria wants a remote engineering role at a company that pays in USD, EUR, or GBP. Applying through generic job portals produces low response rates because applications land in crowded ATS queues, and many companies silently exclude candidates outside their payroll countries. Direct, personalized outreach to decision makers at companies that *demonstrably* hire remote engineers internationally converts far better — but doing it manually at the required volume (300–500 quality touches over 2–3 months) is not feasible.

This system automates the discovery, qualification, enrichment, and drafting stages of that outreach, while keeping a human (the owner) as the final reviewer and sender of every message. The system itself doubles as a portfolio artifact demonstrating the owner's core skill: translating business logic into working automation.

## 2. Goals

1. Discover companies actively hiring for remote software engineering roles matching the owner's stack and seniority.
2. Qualify only companies that (a) accept candidates located in Nigeria (remote-worldwide, EMEA, or Africa-eligible), and (b) pay in USD, EUR, or GBP (explicitly, or by strong proxy).
3. Identify 1–3 decision makers per qualified company (engineering manager, CTO, founder, or senior engineer for referral) with verified email addresses.
4. Generate a personalized outreach draft per target, referencing the specific role, company context, and the owner's relevant quantified achievements.
5. Queue drafts for human review; send only after approval. Automate follow-up scheduling (day 4, day 10) and reply tracking.
6. Track full-funnel metrics: discovered → qualified → enriched → sent → opened → replied → interview.

### Non-Goals (explicitly out of scope)

- **No LinkedIn automation of any kind.** No scraping LinkedIn, no automated DMs/InMails, no browser automation on linkedin.com. Violates LinkedIn ToS and risks account bans. LinkedIn is used manually only.
- No fully autonomous sending. Every message requires explicit human approval.
- No mass/bulk email blasts. Hard cap: 15 new outreach emails per day.
- No applications submitted on the owner's behalf (v1). The system supports outreach, not auto-apply.
- No paid job boards or recruiter marketplaces in v1.

## 3. Success Metrics

| Metric | Target (90 days) |
|---|---|
| Qualified companies in pipeline | ≥ 300 |
| Outreach emails sent | ≥ 350 (incl. follow-ups) |
| Email open rate | ≥ 50% |
| Reply rate (any reply) | ≥ 8% |
| Positive reply rate | ≥ 3% |
| Interviews booked | ≥ 6 |
| Offers | ≥ 1 |
| Email domain reputation | Zero spam-folder blacklisting; bounce rate < 3% |

## 4. User & Context

Single user: the owner. Senior software engineer; strengths in automation, optimization, and translating business logic ↔ technical implementation. Located in Nigeria (WAT, UTC+1 — full overlap with EU working hours, 4–6h overlap with US East Coast mornings). Set up (or willing to set up) as an independent contractor payable via Deel, Remote.com, or direct invoice — this removes the employer's payroll friction and must be stated in outreach.

### Job-search tracks (configurable)

| Track | Default | Filter behavior |
|---|---|---|
| **A. Remote, paid in USD/EUR/GBP** | ON (primary) | Remote-worldwide / EMEA / Africa-eligible roles at companies headquartered or paying in US/EU/UK currency zones |
| **B. Relocation / visa sponsorship** | OFF (toggle) | Onsite/hybrid roles whose descriptions mention visa sponsorship, relocation support, or work-permit assistance |

Tracks use different qualification rules and different email templates. Track B is a config flag, not a code fork.

---

## 5. System Architecture

Seven modules in a linear pipeline with a persistent store at the center. Each module is independently runnable (CLI command / cron job) and idempotent.

```
┌────────────┐  ┌────────────┐  ┌───────────────┐  ┌────────────┐
│ 1. DISCOVER│─▶│ 2. INGEST  │─▶│ 3. QUALIFY &  │─▶│ 4. ENRICH  │
│ (find board│  │ (pull jobs │  │    SCORE      │  │ (find      │
│  slugs)    │  │  via ATS   │  │ (filters +    │  │  people +  │
│            │  │  JSON APIs)│  │  ranking)     │  │  emails)   │
└────────────┘  └────────────┘  └───────────────┘  └─────┬──────┘
                                                         ▼
┌────────────┐  ┌────────────┐  ┌───────────────┐  ┌────────────┐
│ 7. TRACK & │◀─│ 6. SEND &  │◀─│ 5. DRAFT      │◀─│  (store)   │
│  REPORT    │  │  FOLLOW-UP │  │ (LLM persona- │  │  Postgres/ │
│            │  │ (human     │  │  lized email) │  │  SQLite    │
│            │  │  approves) │  │               │  │            │
└────────────┘  └────────────┘  └───────────────┘  └────────────┘
```

### Module 1 — Discovery (find company board slugs)

**Purpose:** Produce a growing list of `(ats_platform, company_slug)` pairs worth ingesting.

**Sources, in priority order:**

1. **Boolean search (Google dorks) against ATS board domains** — used ONLY to discover slugs, never to parse job details from search snippets. Run via a SERP API (SerpAPI, Serper.dev, or Google Programmable Search JSON API) to avoid CAPTCHAs and get structured results. Example dork set (Track A):

   ```
   site:boards.greenhouse.io (backend OR "software engineer" OR platform) ("remote" AND ("worldwide" OR "EMEA" OR "Africa" OR "anywhere"))
   site:jobs.lever.co ("software engineer" OR backend OR fullstack) remote (worldwide OR EMEA OR anywhere)
   site:apply.workable.com "software engineer" remote (worldwide OR EMEA)
   site:jobs.ashbyhq.com "software engineer" remote (worldwide OR EMEA OR anywhere)
   ```

   Track B variant appends: `("visa sponsorship" OR "relocation" OR "visa support")` and country terms (`Germany OR Netherlands OR Canada OR UAE ...`).

   From each result URL, extract only the slug: `boards.greenhouse.io/{slug}/...` → `{slug}`.

2. **Remote job aggregator APIs/feeds** — Remotive public API (`https://remotive.com/api/remote-jobs?category=software-dev`), RemoteOK API (`https://remoteok.com/api`), We Work Remotely RSS. These yield company names; resolve each company name to an ATS slug by probing the four ATS API endpoints with normalized-name guesses (e.g., "Acme Corp" → try `acme`, `acmecorp`, `acme-corp`) and recording whichever returns HTTP 200.

3. **Manual seed list** — CSV of companies known to hire in Nigeria/Africa remotely (e.g., companies seen employing Nigerian engineers on LinkedIn — checked manually). Highest-priority source; these skip straight to score boosts in Module 3.

**Supported ATS platforms & public endpoints (v1):**

| ATS | Discovery domain | Public JSON endpoint |
|---|---|---|
| Greenhouse | boards.greenhouse.io | `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` |
| Lever | jobs.lever.co | `https://api.lever.co/v0/postings/{slug}?mode=json` |
| Ashby | jobs.ashbyhq.com | `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` |
| Workable | apply.workable.com | `https://apply.workable.com/api/v1/widget/accounts/{slug}` (widget API) |

**Behavior:** Runs daily (cron). Dedupes against known slugs. New slugs inserted with `status=discovered`. Rate-limit: ≤ 1 request/sec per host; exponential backoff on 429/5xx; respect robots.txt for any HTML fetch.

**Acceptance criteria:**
- Running `discover` twice in a row produces zero duplicate companies.
- ≥ 100 unique valid slugs discovered in the first week of operation.
- Invalid slugs (404 from ATS API) are marked `dead` and never re-probed more than once per 30 days.

### Module 2 — Ingest (pull structured jobs)

**Purpose:** For every live slug, fetch all current postings as structured JSON and upsert into the store.

**Behavior:**
- Daily poll of each ATS endpoint. Parse: job title, department, location string(s), workplace type (remote/hybrid/onsite where the ATS exposes it), full description HTML→text, absolute URL, posted/updated date, compensation block if present.
- Upsert keyed on `(ats, slug, external_job_id)`. Jobs that disappear from the feed are marked `closed` (do not delete — funnel history matters).
- New jobs at already-qualified companies raise a priority flag (fresh posting = active hiring pain = best time to reach out).

**Acceptance criteria:**
- A Greenhouse, Lever, Ashby, and Workable test slug each ingest ≥ 1 job end-to-end with all fields populated.
- Re-running ingest updates changed jobs without creating duplicates.
- Malformed/HTML-only descriptions degrade gracefully (raw text stored, flagged `needs_review`, pipeline continues).

### Module 3 — Qualify & Score

**Purpose:** Filter jobs/companies down to the ones worth outreach, and rank them.

**Hard filters (any failure ⇒ disqualified, reason recorded):**

| # | Rule | Implementation |
|---|---|---|
| Q1 | Role matches owner's profile | Title/description keyword match against a config list (e.g., `senior`, `staff`, `backend`, `full-stack`, plus stack keywords: `python`, `node`, `react`, `automation`, ...). Seniority: reject `intern`, `junior`, `graduate`. |
| Q2 | Remote-eligible from Nigeria (Track A) | Location/description matched against ALLOW list (`remote worldwide`, `anywhere`, `EMEA`, `Africa`, `global`, `fully remote`) and DENY list (`US only`, `must be located in`, `US timezones only` *unless* EMEA also allowed, `EU citizens only`, `remote (US)`, specific state/city with no remote marker). Ambiguous ⇒ `needs_review`, not auto-reject. |
| Q3 | Pays USD/EUR/GBP (Track A) | Signal cascade, strongest first: (1) explicit compensation with currency symbol/code (`$`, `€`, `£`, `USD`, `EUR`, `GBP`) in the compensation block or description; (2) company HQ in US/UK/EU/CA/AU/CH (enrichment lookup) — HQ currency assumed; (3) mentions of Deel / Remote.com / Oyster / "hire anywhere" ⇒ contractor-friendly, USD assumed. No signal at all ⇒ `needs_review`. |
| Q4 | Visa/relocation present (Track B only) | Description contains `visa sponsorship`, `relocation`, `visa support`, `work permit`. |
| Q5 | Not previously contacted | Company has no prior outreach within 90 days. |

**Soft scoring (0–100, ranks the queue):**

| Signal | Points |
|---|---|
| Company already employs engineers in Nigeria/Africa (from manual seed list or enrichment evidence) | +30 |
| Explicit salary in USD/EUR/GBP stated | +15 |
| "Remote — worldwide/anywhere" (vs. merely EMEA) | +15 |
| Job posted within last 14 days | +15 |
| Stack overlap ≥ 3 of owner's core skills | +10 |
| Company size 11–200 (decision makers reachable, founders read email) | +10 |
| Mentions Deel/Remote.com/Oyster/EOR | +5 |

Threshold: score ≥ 40 ⇒ `qualified`, eligible for enrichment. All rejections keep a machine-readable `disqualify_reason` for tuning.

**Acceptance criteria:**
- Given a labeled test set of 50 real postings (hand-labeled qualified/rejected), filter precision ≥ 90% and recall ≥ 80%.
- Every disqualified job has a stored reason; `needs_review` items appear in the review UI.

### Module 4 — Enrich (find decision makers + emails)

**Purpose:** For each qualified company, produce 1–3 contactable people.

**Target priority by company size:**
- ≤ 50 employees: Founder / CEO / CTO.
- 51–500: VP Engineering / Head of Engineering / Engineering Manager of the relevant team; hiring manager named in the posting if any.
- Fallback at any size: a senior/staff engineer (referral angle), or the recruiter listed on the posting.

**Data sources (legitimate APIs only):** Apollo.io API (people search by company + title, includes verified emails), Hunter.io (domain email patterns + verification), Snov.io (fallback), Proxycurl company endpoint (HQ country, headcount, and headcount-by-country where available — this also feeds Q3 signal 2 and the Nigeria-presence score). **No LinkedIn scraping.**

**Email verification:** Every email must pass a verification step (Hunter/Apollo verifier or MX+SMTP check library). Statuses: `verified`, `risky`, `invalid`. Only `verified` is auto-usable; `risky` requires manual approval; `invalid` is discarded.

**Behavior:** Runs on `qualified` companies in score order, respecting provider rate limits and free-tier quotas (cost guard: configurable monthly credit budget; stop when exhausted, don't fail).

**Acceptance criteria:**
- ≥ 60% of qualified companies yield at least one `verified` contact.
- Zero contacts stored without source attribution (which API, when).
- HQ country populated for ≥ 90% of qualified companies (feeds Q3).

### Module 5 — Draft (LLM personalization)

**Purpose:** Generate one tailored email per (contact, job) pair.

**Inputs to the LLM (Claude API):** the job posting text; company facts from enrichment (product one-liner, HQ, size); contact name/title; the owner's profile pack — a maintained YAML of quantified achievements, stack, timezone, contractor setup, links (GitHub, portfolio, this project's repo).

**Prompt contract (system prompt in `prompts/outreach_v1.txt`, versioned):**
- Output: subject line ≤ 55 chars + body 90–140 words. Plain text. No buzzwords list (config-blocklist: "passionate", "rockstar", "synergy", ...).
- Structure: (1) one specific hook about *their* company/role — never generic; (2) one quantified, relevant achievement of the owner; (3) friction-removal line (WAT timezone overlap, contractor via Deel/Remote.com — one sentence); (4) single soft CTA (15-min call OR "happy to send details"); (5) signature with portfolio + GitHub links.
- Track B template variant emphasizes relocation readiness instead of contractor setup.
- Referral variant (when target is an engineer, not a manager) asks about the team and referral, not a job directly.
- LLM returns JSON: `{subject, body, hook_evidence}` where `hook_evidence` quotes the posting line the hook is based on (anti-hallucination check: hook_evidence must appear in the source text or the draft is auto-flagged).

**Acceptance criteria:**
- 20-draft human eval: ≥ 16/20 rated "would send with ≤ 1 minor edit".
- Zero drafts sent without passing the hook_evidence check.
- Prompt changes are versioned; every draft records its prompt version.

### Module 6 — Send & Follow-up (human in the loop)

**Purpose:** Review queue → approved send → automatic follow-up scheduling → reply detection.

**Review UI (v1 = simplest thing that works):** an Airtable base or a minimal local web page (single-page app) listing drafts with: company, role link, contact, score, draft subject/body (editable), buttons `Approve & Send`, `Edit`, `Reject (reason)`, `Snooze`.

**Sending infrastructure & deliverability (non-negotiable):**
- Dedicated custom domain for outreach (e.g., `yourname.dev` or `mail.yourname.dev`) — never the personal Gmail address directly, never a brand-new domain used same-day.
- SPF, DKIM, DMARC configured and verified before first send.
- 2–3 week warm-up period (manual conversations or a warm-up service) before campaign volume.
- Volume ramp: ≤ 5/day week 1 → ≤ 10/day week 2 → cap 15 new + 15 follow-ups/day thereafter. Randomized send times within a configured window (e.g., 08:30–11:00 in the recipient's likely timezone).
- Sending via Gmail API / Google Workspace SMTP on that domain (v1). Every email includes a genuine unsubscribe/opt-out line ("If this isn't relevant, tell me and I won't write again") and the owner's real identity — compliance with CAN-SPAM / GDPR legitimate-interest norms for individual B2B outreach.
- Open tracking optional via pixel (accept inaccuracy); link tracking via plain UTM parameters only (no obfuscated redirect domains — they hurt deliverability).

**Follow-up logic:** If no reply: follow-up 1 at day 4 (short, adds one new proof point), follow-up 2 at day 10 (breakup email). Any reply ⇒ sequence halts immediately, thread flagged `replied` for manual handling. Bounce ⇒ contact marked `invalid`, company re-enriched once.

**Reply detection:** Poll the mailbox via Gmail API; match by thread/message-ID; classify reply sentiment (LLM: positive / neutral / negative / auto-reply) for reporting only — the human reads every reply.

**Acceptance criteria:**
- It is impossible to send an email that was not explicitly approved (enforced in code path, covered by a test).
- Daily caps enforced even across restarts (persisted counters).
- A reply within the follow-up window provably cancels pending follow-ups (test).
- Bounce rate alarm: if 7-day bounce rate > 3%, sending auto-pauses and alerts the owner.

### Module 7 — Track & Report

**Purpose:** Funnel visibility and weekly tuning.

- Dashboard (CLI report or simple HTML page) showing per-week: discovered, ingested, qualified, enriched, drafted, sent, opened, replied, positive, interviews.
- Per-segment breakdowns: by score band, company size, source (dork vs aggregator vs seed), template version — so the owner learns what converts and tunes filters/prompts.
- Interview/offer stages updated manually in the store.

**Acceptance criteria:** weekly report generated by one command; numbers reconcile with raw tables.

---

## 6. Data Model (minimum viable schema)

```sql
company(id, name, ats, slug, hq_country, size_band, website,
        nigeria_presence bool, source, score int, status, created_at)
  -- status: discovered | ingested | qualified | disqualified | dead

job(id, company_id, external_job_id, title, location_raw, remote_scope,
    currency_signal, comp_raw, description_text, url, posted_at,
    status, disqualify_reason, track)  -- track: A | B
  -- remote_scope: worldwide | emea | africa | us_only | onsite | unknown

contact(id, company_id, full_name, title, role_type, email,
        email_status, source, created_at)
  -- role_type: founder | eng_leader | engineer | recruiter
  -- email_status: verified | risky | invalid

draft(id, contact_id, job_id, subject, body, prompt_version,
      hook_evidence, status, created_at)
  -- status: pending_review | approved | rejected | sent

message(id, draft_id, direction, kind, sent_at, opened_at, replied_at,
        reply_sentiment, thread_id)
  -- kind: initial | followup_1 | followup_2 | reply

event_log(id, entity, entity_id, event, detail_json, at)  -- full audit trail
```

SQLite is sufficient for v1 (single user); Postgres if/when hosted.

## 7. Recommended Tech Stack (opinionated, swap freely)

| Concern | Choice | Why |
|---|---|---|
| Language / Runtime | Node.js 20 (ES modules) | Reuses the existing v2.0 codebase (`@anthropic-ai/sdk`, `axios`, `cheerio`, `nodemailer`, `puppeteer`) — no rewrite needed |
| HTTP | `axios` + `axios-retry` (retries/backoff) + `p-limit` (concurrency caps, already in repo) | Clean per-host rate limiting |
| Parsing | `cheerio` where ATS returns HTML fragments (already in repo) | JSON-first everywhere else |
| Store | SQLite via `better-sqlite3` (sync API, zero-ops) | Migratable to Postgres later via `pg`; replaces current file-based JSON/CSV outputs |
| Migrations | Hand-rolled `.sql` files under `migrations/` applied by a small runner | Simple; SQLite friendly |
| Scheduler | System `cron` calling `node src/pipeline <command>` (or GitHub Actions scheduled workflows for free hosting) | Simple, observable |
| SERP | Serper.dev or SerpAPI (paid, cheap) or Google Programmable Search JSON API (100 free queries/day) — called via `axios` | No CAPTCHA fights |
| Enrichment | Apollo.io + Hunter.io (+ Proxycurl for company data) — REST via `axios` | Legitimate APIs, free tiers to start |
| LLM | Claude API via existing `@anthropic-ai/sdk` (`claude-sonnet-4-6`), using tool-use for structured JSON output | Draft quality; already wired up in `src/ai-matcher.js` |
| Email — sending | Google Workspace on a dedicated domain + Gmail API via `googleapis` npm package (OAuth2) | Deliverability + reply threading + reply polling in one client. Replaces `nodemailer` SMTP for outreach; `nodemailer` may stay for local dev/testing |
| Review UI | Airtable (fastest, zero build) OR a small `Fastify` + HTMX page served locally | Human-in-the-loop with near-zero build cost |
| Config | Single `config.yaml` (keywords, allow/deny lists, caps, track toggle, budgets) parsed with `js-yaml` | Everything tunable without code changes |
| CLI | `yargs` (already in repo) with subcommands: `discover`, `ingest`, `qualify`, `enrich`, `draft`, `review`, `send`, `report` | Consistent with existing `src/index.js` |
| Secrets | `.env`, never committed (already gitignored) | — |

**Note on stack decision:** The PRD originally proposed Python 3.12. We are staying on Node.js 20 because (a) the existing v2.0 repo already contains ~70% of the plumbing we need (Anthropic client, HTTP layer, PDF generator, SMTP, concurrency limiter, CLI framework), (b) every external dependency listed above has a first-class Node client, and (c) rewriting would trade weeks of setup for zero functional gain. The seven-module architecture, data model, filters, prompts, deliverability rules, and acceptance criteria are unchanged.

## 8. Build Plan & Milestones

**Phase 0 — Foundations (weekend 1).** Domain purchased; SPF/DKIM/DMARC live; warm-up started (runs in background through Phases 1–2). Repo scaffold, config, schema, event log. *Exit: DMARC report received; `node src/pipeline init` creates the SQLite DB and runs migrations.*

**Phase 1 — Discover + Ingest (week 1).** Dork discovery via SERP API for all four ATS platforms; aggregator feeds; slug probing; daily ingest. *Exit: ≥ 100 companies, ≥ 300 jobs in DB from a scheduled run.*

**Phase 2 — Qualify + Score (week 2).** Hard filters Q1–Q5, scoring, labeled test set, `needs_review` flow. *Exit: precision/recall targets met on the 50-posting test set.*

**Phase 3 — Enrich (week 3).** Apollo/Hunter/Proxycurl integration, verification, cost guard. *Exit: ≥ 60% contact coverage on top-50 companies.*

**Phase 4 — Draft + Review + Send (week 4).** Prompt v1, hook_evidence check, review UI, approval-gated Gmail send, caps, follow-ups, reply detection. *Exit: first 5 real approved emails sent; follow-up cancellation test green.*

**Phase 5 — Track + Tune (week 5+, ongoing).** Weekly report; ramp to 15/day; A/B template versions; open-source the repo (secrets stripped) and add the link to the email signature and portfolio.

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Emails land in spam → wasted pipeline | Dedicated warmed domain, auth records, low caps, plain-text style, bounce alarm auto-pause |
| Enrichment credits exhausted / cost creep | Monthly budget guard in config; enrich in score order only |
| ATS blocks/ratelimits | 1 req/s, backoff, daily (not hourly) polling, cache |
| LLM hallucinated hooks damage credibility | hook_evidence verification; human review of 100% of sends |
| "Remote worldwide" postings that quietly exclude Africa | Nigeria-presence signal weighting; treat replies as data; deny-list companies that decline on location |
| Legal/compliance concerns (GDPR) | Individual, identified, relevant B2B outreach with opt-out honored immediately; contacts deleted on request; no data resale |
| Over-automation temptation | Sending path physically requires approval flag; no bulk-approve button in v1 |

## 10. Open Questions (decide during build)

1. Airtable vs. self-built review UI — pick whichever gets Phase 4 done faster.
2. Add SmartRecruiters / Recruitee / BambooHR boards in v2?
3. Auto-detect "hiring manager" named inside job descriptions (regex + LLM extraction) as a cheaper enrichment path?
4. v2: light auto-apply for ATS forms alongside outreach?

## 11. Definition of Done (v1)

- All Phase 0–4 exit criteria green.
- One command (`make daily`) runs discover → ingest → qualify → enrich → draft and populates the review queue.
- Owner reviews and sends within a 20-minute daily session.
- Weekly report shows a funnel with non-zero replies by week 6.
- Repo is public, documented (README explains the business logic → technical mapping), and linked in outreach signatures.
