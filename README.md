# Job Finder

Two products in one repo:

- **v3 outreach pipeline** (`src/pipeline/*`): the current active build. A seven-module system that discovers companies actively hiring remote engineers, qualifies them, enriches with decision-maker contacts, drafts personalized outreach, and sends after human approval. Follows [PRD-remote-job-outreach-system.md](PRD-remote-job-outreach-system.md).
- **v2 auto-apply** (`src/index.js` and siblings): the previous version. Finds jobs across ATS aggregators, generates tailored resumes and cover letters, and can auto-send applications. **Deprecated but still runnable** via `npm run v2:search`. Do not extend it. New work happens in `src/pipeline/`.

## v3 pipeline: quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env         # fill in keys as you unlock them
cp config.example.yaml config.yaml   # already done for you if this is a fresh clone

# 3. Create the SQLite DB and run migrations
npm run pipeline:init

# 4. Run tests to verify the wiring
npm test

# 5. Individual modules (each command is idempotent)
npm run pipeline:discover     # Module 1: find company slugs
npm run pipeline:ingest       # Module 2: fetch jobs from ATS APIs
npm run pipeline:qualify      # Module 3: filter + score (Week 3)
npm run pipeline:enrich       # Module 4: find contacts (Week 4)
npm run pipeline:draft        # Module 5: LLM drafts (Week 5)
npm run pipeline:send         # Module 6: approved sends only (Week 5)
npm run pipeline:report       # Module 7: funnel report

# One-shot daily run (excludes send, which is human-gated)
npm run pipeline:daily
```

## v3 pipeline: current status (Weeks 1-2 complete)

**Week 1 foundation:**

- SQLite schema and migration runner (`migrations/001_initial_schema.sql`)
- Config with Zod validation (`config.example.yaml` + `src/pipeline/config/`)
- Event log with append-only history of every state transition
- Repo layer for company, job, contact, draft, message, suppression, send counters, dead slugs
- HTTP client with retry/backoff and per-host concurrency limits
- Structured logging (pino)
- CLI skeleton with all eight subcommands
- Send guards: cannot send unapproved drafts, cannot send to suppressed addresses, cannot exceed daily cap

**Week 2 discovery + ingest:**

- All four ATS clients real: Greenhouse, Lever, Ashby, Workable (each with `probe` + `fetchJobs`)
- Shared classifiers for workplace type, remote scope, currency, and slug candidates
- Aggregator feeds: Remotive + RemoteOK, with dedup and hint extraction from URLs
- Slug resolver: turns aggregator company names into (ats, slug) pairs by probing candidate variants
- Discover module wired end-to-end: seed CSV -> SERP dorks -> aggregators
- 48 tests across 10 files, all green, covering fixtures for every ATS + aggregator

Not yet implemented (per PRD phase plan):

- Week 3: Qualify module (Q1-Q5 filters + scoring) + 50-posting labeled test set
- Week 4: Enrich module (Hunter integration + verifier + cost guard)
- Week 5: Draft module (LLM + hook_evidence), review UI (Airtable), Gmail send, follow-up scheduler, reply detection
- Week 6+: Track/tune, weekly report breakdowns

## Directory layout

```text
src/
├── pipeline/                      # v3 outreach system
│   ├── cli.js                     # single entry point (yargs subcommands)
│   ├── db/                        # SQLite: connection, migrate, repo, event log
│   ├── config/                    # loader + Zod schema
│   ├── util/                      # logger, http
│   ├── discover/                  # Module 1
│   │   ├── seed.js                # CSV loader
│   │   ├── serp.js                # Serper.dev dork discovery
│   │   ├── resolve-slug.js        # company name -> (ats, slug) via probing
│   │   └── aggregators/           # remotive.js, remoteok.js
│   ├── ingest/                    # Module 2
│   │   └── ats/                   # classify.js + greenhouse | lever | ashby | workable
│   ├── qualify/                   # Module 3 (stub)
│   ├── enrich/                    # Module 4 (stub)
│   ├── draft/                     # Module 5 (stub + hook verifier)
│   ├── send/                      # Module 6 (guards live, transport stub)
│   └── report/                    # Module 7
├── ai-matcher.js                  # SHARED with v2
├── utils.js                       # SHARED
├── config.js                      # v2 env config
└── (v2 files: index.js, job-aggregator.js, email-sender.js, ...)

migrations/001_initial_schema.sql   # applied by src/pipeline/db/migrate.js
prompts/outreach_v1.txt             # LLM prompt for Module 5
tests/                              # vitest suite
config.example.yaml
.env.example
```

## v2 (legacy) reference

Kept for reference and occasional use. Commands are namespaced under `v2:`:

```bash
npm run v2:setup        # parse resume.pdf into data/profile.json
npm run v2:search       # find jobs, generate tailored resumes/cover letters
```

Do not send emails from v2 while v3 is being built. v2's sender does not
respect the v3 suppression list, cap logic, or event log.

## Deploying to Railway

The pipeline is designed to run as a **Railway cron job**, not a long-running service. Each cron fire spins up a fresh container, runs `pipeline:daily`, and exits. State is preserved in a mounted Volume holding `data/pipeline.db`.

### One-time setup

1. Create a GitHub repo and push this code (see the initial commit for the file list).
2. In Railway → your workspace → **New Project** → **Deploy from GitHub repo** → pick the repo.
3. **Settings → Volumes → Add Volume**: mount path `/app/data`, size `1 GB`.
4. **Variables**: paste every key from your local `.env` one at a time. Do not upload `.env` itself.
5. Add these two extra variables:
   - `PIPELINE_DB_PATH=/app/data/pipeline.db`
   - `NODE_ENV=production`
6. Railway reads `railway.json` for the cron schedule (default: `0 7 * * *`, meaning 07:00 UTC = 08:00 WAT). Adjust in the file or in **Settings → Cron Schedule**.

### Why cron and not always-on

`pipeline:daily` runs the whole discover → ingest → qualify → enrich → draft → report chain in under a few minutes on a normal day. Keeping a container idle for the other 23 hours would burn RAM budget for no benefit. Cron matches the workload.

### Verifying a run

Railway → Deployments → click the latest run → **View Logs**. You will see structured pino output ending with the funnel report line. If it fails, the logs show which module threw.

### Cost estimate

Hobby plan is $5/month flat. A daily cron run of 2 to 5 minutes uses a small fraction of the included execution time. The 1GB Volume adds about $0.25/month. Total: under $6/month.

## Requirements

- Node.js 20+
- `pdftotext` (from poppler) for v2 resume parsing only: `brew install poppler`
- Chromium (auto-installed by Puppeteer) for v2 PDF generation only. **Skipped during Railway builds** via `.npmrc`.
