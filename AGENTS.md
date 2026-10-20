# Agent instructions

## Overview

Dispose Me - Cloudflare is a disposable email application using Node.js 24, Yarn 4.18.1, TypeScript, Express, EJS, Tailwind v4, Workers Email Routing, D1, R2, and Terraform 1.13.3. Preserve the MIT attribution. Email content and credentials are private: never commit tokens, live messages, Terraform state, backend credentials, or generated deployment configuration.

## Project structure

```text
cloudflare/                  Worker handlers, D1/R2 adapters, deployment/build tools
cloudflare/migrations/       Versioned D1 SQL migrations
service/api/                Express routes and inbox controller
service/tools/              Validation, cookies, normalization, logging, RSS
service/views/              EJS templates and partials
service/assets/css/         Tailwind source; output.css is generated
infra/cloudflare/storage/   D1, R2, lifecycle policy, deployment outputs
infra/cloudflare/routing/   Custom domain, Email Routing, reserved-address forwarding
infra/cloudflare/state/     Dedicated R2 state bucket; separate self-hosted state
test/                       Native Node tests executed through tsx
docs/                       API schema, deployment permissions, production readiness
```

## Architecture

The Worker composes the Express app with D1/R2 dependencies. Keep storage I/O in the adapters and MIME parsing in `cloudflare/EmailParser.ts`. The email handler uses the SMTP envelope recipient, not To/Cc headers, for inbox membership. EJS is compiled at build time; Workers must not call eval/new Function at runtime. Terraform owns infrastructure and routing. All three Terraform roots store state in a dedicated private R2 bucket with independent keys and native lockfiles. Use `cloudflare/terraform-state.mjs` for backend initialization/credentials and the configured R2 endpoint for every state operation. Wrangler owns code, assets, bindings, the cleanup schedule, secrets, and D1 schema migrations. Neither tool should overwrite resources owned by the other.

## Data contracts

Email metadata has a `(Username, Id)` key in D1 and an explicit expiration time. Raw MIME bytes live in R2 under a SHA-256 ID. Preserve byte-for-byte downloads and charset-aware parsing. Read paths must hide expired metadata before cleanup. Types belong beside their parser, adapter, or controller, not in provider SDKs. Public HTTP responses retain the documented contract in `docs/schema.yaml`.

## Coding & testing guidelines

Biome defines formatting: two spaces, single quotes, semicolons, 100 columns. Use named exports except the Worker default handler and inherited Logger export. Use the Logger instead of console calls, async/await, and typed object contracts. Keep EJS styling in Tailwind classes; generated CSS/templates stay ignored. Use `node:test` with `test()` and given/when/then comments. Test meaningful behavior; the integration suite runs the real local Workers runtime with isolated state. There is no numeric coverage gate; all verification suites must pass. Keep `enableScripts: false` and `npmMinimalAgeGate: 7d` in `.yarnrc.yml`. Do not bypass the age gate or change Git configuration. Commit/push only when requested; create pull requests in draft mode unless instructed otherwise.

## Deprecated

- Runtime EJS compilation is unsupported in Workers. Use the build-time template compiler.
- Local-only Terraform state is unsupported for deployments. Use the R2 backend and native lockfiles.
- Email HTML is not yet sandboxed. Track its remediation in `docs/production-readiness.md`; do not extend this unsafe rendering pattern.

## Verification

Run `make test`, the same aggregate used by CI. If a child fails, iterate on that child (`make test/unit`, `make test/worker`, `make test/integration`, or `make test/infra`) and rerun the aggregate once after the fix. Verification uses mocked Terraform and local Workers resources, not live deployment credentials.

## Code review

Check that envelope routing cannot expose reserved addresses, recipient-specific deletion preserves other inboxes, and D1 schema changes are compatible with running code. Reject token logging, committed state, application secrets in Terraform inputs, and accidental DNS/MX changes. Require an explanation for shared-infrastructure ownership changes and verify that deployment changes preserve unrelated domain records.
