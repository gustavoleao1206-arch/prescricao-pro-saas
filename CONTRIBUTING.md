# Contributing

Thanks for your interest. Code, comments and UI text are in Brazilian
Portuguese; issues and pull requests can be written in English or Portuguese.

## Workflow

1. Fork the repository and clone your fork.
2. Create a branch from `main`: `git switch -c short-description`.
3. Make the change, with tests.
4. Run the checks below and make sure they pass.
5. Open a pull request against `main` explaining **what** changed and **why**.
   The CI quality gate (`.github/workflows/portao.yml`) runs the same checks.

Security problems are not reported through pull requests — see
[SECURITY.md](SECURITY.md).

## Checks

```bash
npm ci
npx prisma generate
npm run typecheck
npm run lint
npm test                 # starts a disposable PostgreSQL 16 by itself (port 55432)
DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" \
AUTH_SECRET="valor-de-fachada-do-build-substituido-em-execucao" npm run build:check
```

`PTP_PG_BASE` and `PTP_PG_PORT` change where the test database lives and which
port it uses. Run the suite inside a git checkout (some tests use `git grep`).

## Project conventions

These rules are referenced from comments in the code. Each one exists because
breaking it already caused a real defect.

### Tests

- **Database tests are registered in two places.** A test file that needs
  PostgreSQL goes in `TESTES_DE_BANCO` (`scripts/pg-teste.mjs`) **and** in the
  `--exclude` list of `test:sem-banco` (`package.json`); otherwise it runs
  without a database and fails.
- **A test's data prefix must not start with another file's prefix.** Cleanups
  use `startsWith`, so one file would delete the other's data mid-run. The
  symptom is the worst kind: it passes alone and on the second run, and fails
  only on the first run after the database is reset.
- **Never look up audit logs or security events with `findFirst` on the whole
  table.** Filter by something that belongs to the case under test (a payment
  id, an analysis id), or the test passes because of a row left by another run.
- **Verify a fix by reverting it.** After fixing a bug, disable the fix and
  confirm the new tests fail. A test that passes in both states proves nothing.
- **Run the suite twice, starting from a fresh database,** before calling it
  green. The second run is what exposes order dependence and leftovers. A test
  that fails once and passes on retry is a defect to investigate, not noise.
- Never put real personal data in tests or comments. Use the generated CPF
  `52998224725` and e-mail addresses under `@exemplo.local`.

### `server-only` and Node entry points

`src/lib/db.ts` and `src/lib/env.ts` import `server-only`, so the build fails if
the Prisma client or environment variables leak into the browser bundle. That
package throws when loaded outside Next.js, so every Node entry point that
reaches `db.ts` runs as:

```bash
tsx --tsconfig tsconfig.scripts.json <script>
```

`package.json`, the `Dockerfile` and `render.yaml` already do this, and
`tests/entradas-node.test.ts` rejects new entry points that don't. Do not use
`tsx --conditions=react-server` instead: it breaks React outside its
experimental channels.

### Secrets and environments

- `.env` is never committed. Start from `.env.example`, which is safe by
  default (`ASAAS_ENV=sandbox`, empty keys).
- Never put the production payment key or the production `DATABASE_URL` on a
  development machine: with the first, a local test charges a real card; with
  the second, it touches real client data.

### Payments (Asaas) invariants

- `Subscription.nextRenewalAt` set means "this subscription charges itself".
  PIX and manual sales leave it `null`. Setting it where nothing charges
  automatically promises a renewal nobody performs and stops the daily job
  from closing the cycle.
- `Subscription.analysesQuota === 0` means **unlimited** (legacy plans), not
  zero credits.
- `Subscription.canceledByRequestAt` is the immutable "customer asked to stop
  billing" mark; only a new purchase clears it.
- `Payment` does not cascade with the subscription. In tests and scripts, look
  payments up by `externalId`, never by `subscriptionId`.
- Asaas stops delivering webhooks after the first event that fails, so webhook
  handlers must never throw; `reconciliarPagamentos` exists so that granting
  access does not depend on the webhook arriving.

### Infrastructure as code

`render.yaml` is a Render Blueprint: a new variable added there reaches
production with the push. Only secrets (`sync: false`) are set in the dashboard.
`tests/render-fila.test.ts` keeps the worker's configuration in sync with the
web service's.
