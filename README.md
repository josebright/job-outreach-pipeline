# Job Outreach Pipeline

Discovers companies actively hiring remote software engineers, qualifies fit against a configured profile, enriches with decision-maker contacts, drafts personalized outreach with an LLM, and sends after human approval. Runs as a Railway cron job. State lives in SQLite.

See [PRD-remote-job-outreach-system.md](PRD-remote-job-outreach-system.md) for the full design.

## Architecture

Seven modules in a linear pipeline. Each is a CLI subcommand, idempotent, and re-runnable.

```text
discover  ->  ingest  ->  qualify  ->  enrich  ->  draft  ->  send  ->  report
   |            |            |           |          |         |
company     job posts    filter +    contacts +   LLM      approved
slugs from  from ATS     score       verified     +hook    only,
seed+SERP+  APIs                     emails       check    daily cap
aggregators
```

Every state transition is written to `event_log` for audit and replay.

## Sending safety (enforced in code, covered by tests)

- A draft with any status other than `approved` cannot be sent.
- Any address in the suppression list cannot be sent to. Case-insensitive.
- Daily send caps are persisted to SQLite, so restarts do not reset the count.

These invariants live in `src/pipeline/send/index.js` and cannot be bypassed by any caller.

## Configuration

Two files, two roles.

- `config.yaml` — non-secret runtime tunables: keyword lists, allow/deny locations, currency map, scoring weights, ATS platforms, send caps, sender identity. Validated by Zod on startup.
- `.env` — secrets only: API keys and OAuth credentials. See `.env.example` for the full list and how to obtain each.

For local dev, copy `config.example.yaml` to `config.yaml` and `.env.example` to `.env`.

## Local usage

```bash
npm install
npm run pipeline:init      # create SQLite and apply migrations
npm test                   # 48 tests, all green
npm run pipeline:discover  # populate companies
npm run pipeline:ingest    # pull jobs from ATS APIs
npm run pipeline:report    # show funnel counts
```

Each subcommand is documented in `src/pipeline/cli.js`.

## Deployment

Runs on Railway as a **cron service**. The container spins up on schedule (`0 7 * * *` UTC by default, see `railway.json`), runs `pipeline:daily`, exits. SQLite state persists across runs via a Railway Volume mounted at `/app/data`.

### First-time setup

The initial deployment was done once from this repo:

1. `git init && git push` to a GitHub repo.
2. In Railway → **New Project** → **Deploy from GitHub repo**.
3. `railway link` to the project locally.
4. `railway volume add --mount-path /app/data` to attach persistent storage.
5. `railway variables --set KEY=VALUE ...` to push every `.env` key, plus `PIPELINE_DB_PATH=/app/data/pipeline.db` and `NODE_ENV=production`.

Redeploys happen automatically on `git push` to `main`.

### Cost

Hobby plan $5/month + 5GB Volume $1.25/month = about **$6.25/month**.

## Directory layout

```text
src/pipeline/
├── cli.js                          # yargs subcommands
├── db/                             # SQLite: connection, migrate, repo, event log
├── config/                         # loader + Zod schema
├── util/                           # logger, http
├── discover/                       # Module 1
│   ├── seed.js                     # CSV loader (data/seed_companies.csv)
│   ├── serp.js                     # Google PSE + Serper dork search
│   ├── resolve-slug.js             # company name -> (ats, slug) via probing
│   └── aggregators/                # remotive.js, remoteok.js
├── ingest/                         # Module 2
│   └── ats/                        # classify.js + greenhouse | lever | ashby | workable
├── qualify/                        # Module 3
├── enrich/                         # Module 4
├── draft/                          # Module 5 (+ hook_evidence verifier)
├── send/                           # Module 6 (guards + Gmail transport)
└── report/                         # Module 7

migrations/                         # applied by src/pipeline/db/migrate.js
prompts/                            # LLM system prompts (versioned)
tests/                              # vitest suite + fixtures
```

## Requirements

- Node.js 22 or 24 LTS. Production runs on Node 24 (Active LTS through April 2028); Node 22 is Maintenance LTS through April 2027 and works locally.
- macOS or Linux for local dev (better-sqlite3 needs a native compile)
