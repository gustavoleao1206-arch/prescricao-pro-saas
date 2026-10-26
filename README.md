**English** · [Português (Brasil)](README.pt-BR.md)

# Prescrição Pro

SaaS for Brazilian tax lawyers: statute-of-limitations (*prescrição*/*decadência*) analysis of tax enforcement lawsuits.

A lawyer uploads the PDF of a tax enforcement case; the platform reads it (OCR included), finds the procedural milestones, runs a deterministic deadline calculation together with an LLM, and returns a structured report plus a draft motion for the lawyer to review. Access is sold as credits and subscriptions through the Asaas payment gateway.

**Status:** live in production at [prescricaopro.com.br](https://prescricaopro.com.br). The UI, code comments and legal texts are in Brazilian Portuguese.

> The product's legal knowledge base and production AI instructions are proprietary and are **not** in this repository. `knowledge/`, `src/lib/ai/prompts.ts`, `src/lib/ai/prompts-materia.ts`, `src/lib/ai/prompts-peca.ts` and `src/lib/ai/motores/` contain short generic samples with the same exports and structure, so the app, the seed script and the test suite run end to end. The tests for those files check structure, not wording.

---

## The problem, for non-Brazilian readers

In Brazil, unpaid taxes are collected through a lawsuit filed by the government (federal, state or municipal). Many of these cases sit idle for years, and the government loses the right to collect if certain deadlines run out. Proving that requires reading hundreds of pages of court records and reconstructing a timeline date by date — slow, error-prone work for a law firm.

| Term | Meaning |
|---|---|
| **Execução fiscal** | Tax enforcement lawsuit: the government suing a taxpayer to collect a registered tax debt. |
| **CDA** (*Certidão de Dívida Ativa*) | Certificate of tax debt — the enforceable title the lawsuit is based on. |
| **Prescrição** | Statute of limitations to *collect* a tax: five years from the final assessment (CTN, art. 174). |
| **Prescrição intercorrente** | Limitation that runs *inside* a pending lawsuit when it stalls (no debtor or assets found): a one-year suspension followed by five years (LEF, art. 40). |
| **Decadência** | Deadline for the tax authority to *assess* the tax in the first place (CTN, arts. 150 §4 and 173). |
| **LEF** | *Lei de Execuções Fiscais* — Federal Law 6,830/1980, the procedural law for these lawsuits. |
| **CTN** | *Código Tributário Nacional* — Brazil's National Tax Code. |
| **Exceção de pré-executividade** | A motion that lets the defendant raise issues such as limitation without first posting a bond. It is the draft the platform produces. |
| **LGPD** | Brazil's General Data Protection Law (similar in spirit to the GDPR). |
| **PIX / boleto** | Brazilian instant payment / bank payment slip. |

## Features

- **Case upload → reading → analysis → deliverables.** PDF and image upload, text extraction with `unpdf`, OCR of scanned pages with Ghostscript + Tesseract (Portuguese), and per-page citations in the result.
- **Three analysis types** (*matérias*): *prescrição intercorrente*, *prescrição ordinária* and *decadência*, each with its own document checklist and instructions (`src/lib/ai/motores/`).
- **Deterministic legal engine + LLM.** Date arithmetic and limitation rules live in code (`src/lib/legal/`); the LLM extracts and argues, the server checks the math. Without an API key the platform still runs in a clearly labeled heuristic (deterministic-only) mode.
- **Report and draft petition**, versioned per analysis, exportable to DOCX and PDF, always with a mandatory "review by a licensed lawyer" notice.
- **Credits and subscriptions via Asaas:** recurring card checkout, boleto subscriptions, one-off PIX, single-credit purchases, plan upgrade/downgrade, and a daily credit-maintenance job.
- **Multi-tenant accounts** (organizations) with four roles — client, legal reviewer, support and admin — plus an admin panel for users, plans, versioned prompts, the knowledge base and AI cost vs. revenue.
- **LGPD tooling:** data export, account deletion, data-subject requests, consent records and executable retention rules.

## Tech stack

| Layer | Technology |
|---|---|
| Web | Next.js 15 (App Router, route handlers), React 19, TypeScript, Tailwind CSS |
| Data | PostgreSQL + Prisma ORM (31 models, 14 migrations) |
| AI | OpenAI or Anthropic API, server-side only, behind one provider interface (`src/lib/ai/provider.ts`) |
| Documents | `unpdf`, Ghostscript + Tesseract OCR, `docx` and `pdf-lib` for exports |
| Payments | Asaas (hosted checkout, subscriptions API, webhooks) |
| Jobs | Queue driver `sync` / `async` / BullMQ + Redis worker |
| Storage / e-mail | Local disk or S3-compatible bucket; console or Resend |
| Tests / CI | Vitest, embedded PostgreSQL 16, GitHub Actions |
| Deploy | Docker (non-root), Render Blueprint (`render.yaml`: web, worker, cron, Redis, Postgres) |

## Architecture

```mermaid
flowchart LR
    B[Browser] --> M[Middleware<br/>CSP nonce, session gate]
    M --> R[Pages and route handlers<br/>src/app]
    R --> S[Domain services<br/>src/lib]
    S --> DB[(PostgreSQL<br/>Prisma)]
    S --> FS[(Private storage<br/>local or S3)]
    S --> Q{{Queue<br/>sync, async or BullMQ}}
    Q --> P[Analysis pipeline]
    P --> O[OCR<br/>Ghostscript + Tesseract]
    P --> L[Deterministic legal engine<br/>src/lib/legal]
    P --> AI[LLM provider<br/>OpenAI or Anthropic]
    A[Asaas] -- webhook --> R
    R -- checkout --> A
```

Analysis pipeline, in order: text extraction and OCR → deterministic document checklist and key-event detection → page selection within the token budget → LLM call with the matter-specific instructions → response sanitization and temporal verification → report, timeline and draft petition persisted for review. More detail in [ARQUITETURA.md](ARQUITETURA.md), [BANCO_DE_DADOS.md](BANCO_DE_DADOS.md) and [ASAAS.md](ASAAS.md) (Portuguese).

## Engineering highlights

- **The server checks the AI's arithmetic.** `src/lib/legal/verificacao-temporal.ts` recomputes the limitation date from the milestones the model chose; a "yes, it expired" with a future expiry date is corrected to "no", and the opposite contradiction triggers a second model pass with the system's own calculation in front of it. Both rules came from real regression cases and are covered in `tests/verificacao-temporal.test.ts`.
- **Deterministic pre-processing feeds the prompt.** Pattern-based detection of key court events (`src/lib/legal/deteccao-eventos.ts`) and a per-matter document checklist run before the LLM, so a decisive certificate on page 300 is not lost when the text is truncated to fit the budget (`src/lib/legal/selecao-paginas.ts`).
- **Money paths are idempotent and tested against a real database.** Credits are a ledger with a unique idempotency key per billing cycle, so a re-delivered webhook (or the CONFIRMED → RECEIVED pair of the same payment) never credits twice; webhook tokens are compared in constant time. The credit is debited before the LLM call and refunded when processing fails — including analyses left behind by a crashed process, which a sweep marks as failed — and an upload with no readable page is not charged at all. A regression test replays the real shape of an Asaas recurring-payment webhook (identifiers anonymized).
- **Security:** TOTP two-factor authentication with hashed single-use backup codes; opaque session tokens stored hashed, with absolute and idle timeouts (shorter for staff); bcrypt (cost 12); login lockout and rate limits; a strict Content-Security-Policy with a per-request nonce on the private area; the Next.js image optimizer disabled; a `server-only` guard so the Prisma client and secrets cannot reach the browser bundle (enforced by tests).
- **LGPD by design:** CPF/CNPJ, 2FA secrets and the full text of uploaded court records are encrypted at rest with AES-256-GCM (`src/lib/crypto.ts`, `src/lib/pagina-do-processo.ts`); retention periods are a single source of truth shared by the privacy policy page and the purge job (`src/lib/retencao.ts`); audit logs are sanitized.
- **Tenant isolation in two layers:** every query goes through the tenant context (`src/lib/tenant.ts`), and Postgres row-level-security policies for the seven case-content tables are shipped as a migration, tested with a dedicated non-owner role (`tests/tranca-do-banco.test.ts`); they take effect when the app connects with that role (`prisma/rls/usuario-de-aplicacao.sql`).
- **Tests that guard configuration, not just code:** the suite fails if the CI quality gate is emptied, if a Node entry point is launched without the `server-only` workaround, if the Render worker's settings drift from the web service's, or if `docker-compose.yml` publishes a port beyond `127.0.0.1`.
- **Quality gate in CI** (`.github/workflows/portao.yml`): type check, lint, the full test suite against PostgreSQL and a production build on every pull request.

## Running locally

Requirements: Node.js 20+ and a PostgreSQL 16 server. Docker is optional: `docker-compose.yml` starts Postgres, Redis and MinIO bound to `127.0.0.1`, and `npm run db:teste` starts a disposable embedded PostgreSQL 16 on `127.0.0.1:55432` without Docker.

```bash
npm ci
npx prisma generate
cp .env.example .env
# Edit .env: DATABASE_URL, AUTH_SECRET, FIELD_ENCRYPTION_KEY (openssl rand -base64 32),
# SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD and SEED_DEMO_PASSWORD.
npx prisma migrate deploy
npx prisma db seed   # runs prisma/seed.ts with the variables from .env
npm run dev          # http://localhost:3000
```

The seed refuses to run without `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`, and refuses to create the demo accounts (client, reviewer, support) without `SEED_DEMO_PASSWORD` — no password is hard-coded. With `NODE_ENV=production` it creates no demo data at all and rejects weak or known admin passwords.

Without `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` the analysis runs in heuristic mode; without `ASAAS_API_KEY` the checkout reports that payments are not configured. `ASAAS_ENV` defaults to `sandbox`.

## Running the tests

```bash
npm test                 # whole suite; starts a disposable PostgreSQL 16 by itself
npm run test:sem-banco   # only the tests that do not need a database
npm run typecheck
npm run lint
# production build into .next-check; the two variables are placeholders, as in CI
DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" \
AUTH_SECRET="valor-de-fachada-do-build-substituido-em-execucao" npm run build:check
```

`npm test` downloads the official PostgreSQL 16 binaries through npm into `C:/Users/Public/ptp-pgtest` on Windows (or the system temp folder elsewhere), starts it on port 55432 and applies the migrations. `PTP_PG_BASE` and `PTP_PG_PORT` override the folder and port. Run it from a git checkout: a few tests use `git grep`.

Latest run: **985 tests in 81 files, all passing** — 524 of them (40 files) against the real PostgreSQL instance rather than mocks, because the idempotency that protects payments lives in transactions and unique keys, and 461 (41 files) without a database.

## Repository layout

```
prisma/        schema, migrations, row-level-security scripts, seed
knowledge/     sample knowledge base (one file per matter; the real one is proprietary)
scripts/       test database, credit maintenance, payment reconciliation, restore check
src/app/       (marketing) public site and legal texts · (auth) · (app) client area
               (admin) back office · api/ route handlers
src/lib/       auth, 2FA, credits, Asaas, storage, OCR, tenant, retention, CSP
src/lib/ai/    provider, analysis orchestration, per-matter instructions
src/lib/legal/ deterministic limitation engine, event detection, temporal verification
tests/         Vitest suite
```

## License

The source code is released under the [MIT License](LICENSE). The names "Prescrição Pro" and "Leão Amorim", the logos, the artwork in `public/` and the site's legal and marketing texts are not covered by that license and remain reserved.

This software is a support tool for lawyers. It does not replace the professional judgment of a licensed attorney and does not guarantee any court outcome.
