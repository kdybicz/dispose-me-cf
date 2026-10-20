# Dispose Me - Cloudflare

A self-hosted disposable email service running on Cloudflare Workers, Email
Routing, D1, and R2. It provides an inbox UI, JSON API, RSS feeds,
attachment downloads, private/public access, and automatic expiration.

## Local development

Use Node.js 24, Yarn 4.18.1 via Corepack, and GNU Make. Install Terraform 1.13.3
to run the infrastructure checks. `.nvmrc` and `.terraform-version` select the
supported tool versions.
If your Node distribution does not include Corepack, install it with
`npm install --global corepack` before enabling it.

```bash
corepack enable
make setup
cp .dev.vars.example .dev.vars
make start
```

Choose a local `ACCESS_TOKEN` in `.dev.vars`, using 20-50 alphanumeric characters.
Open `http://localhost:8787` and log in with that token. `make start` applies local
D1 migrations and builds CSS/templates before starting Wrangler. No Cloudflare
account is needed for local development.

Send the included local RFC 5322/MIME fixture:

```bash
curl 'http://localhost:8787/cdn-cgi/local/email?from=sender@example.net&to=test@example.com' \
  --data-binary @test/fixtures/example.eml
```

Then open `/inbox/test`. Local D1/R2 data is kept under `.wrangler/`.

## Verification

```bash
make test
```

This is the same entry point used by GitHub Actions. It includes lint, unit tests,
deployment-tool tests, a typechecked Worker bundle, the actual local Workers
email-to-inbox integration test, and mocked Terraform tests. The integration suite
uses separate local state and tests reception, normalization, Bcc-style delivery,
duplicate delivery, MIME/charset handling, attachments, EJS rendering, authentication,
RSS, deletion, and expiry. The suite does not send live mail or apply infrastructure.

Browser regression tests are opt-in and do not run in CI or `make test`:

```bash
yarn exec playwright install chromium
yarn test:browser
```

This runs the local integration suite with additional Chromium checks for inline
CID images (including a 3 MiB PNG) and sandbox isolation against synthetic hostile
HTML. On Linux hosts missing browser system libraries, install them with
`yarn exec playwright install --with-deps chromium`.

Use `make` to list commands. Yarn entry points include `yarn dev`, `yarn build`,
`yarn test`, `yarn deploy`, `yarn config`, and `yarn infra`.

Each live environment uses its own R2 state prefix and configuration. `make deploy`
defaults to this checkout; `make deploy environment=/path/to/another/checkout`
selects another configured environment's checkout. `make clean` preserves backend configuration and
credentials. There is intentionally no blanket `nuke` target for a checkout
containing backend metadata and untracked secrets.

## Deploy to Cloudflare

Follow these guides in order:

1. [Create the Cloudflare API token](docs/cloudflare-api-token.md).
2. [Provision and deploy the application](infra/cloudflare/README.md).

The deployment sequence is storage, schema migrations, Worker/assets, login
secret, then domain/email routing. Terraform state is stored in a dedicated private
R2 bucket with separate keys and native lock files for state/storage/routing.
Routing requires an active Cloudflare zone and enables HTTP-to-HTTPS redirects.
The `www` hostname redirects permanently to the HTTPS apex with paths and query
strings preserved.

Before running these commands, fill in the ignored storage `terraform.tfvars`
file as described in the deployment guide and export `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and the application `ACCESS_TOKEN` in your shell.

```bash
yarn state:bootstrap
yarn infra storage init
yarn infra storage plan
yarn infra storage apply
yarn deploy --dry-run
yarn deploy
yarn infra routing init
yarn infra routing plan
yarn infra routing apply
```

The helper can derive R2 state credentials from the R2-capable deployment token, or use a dedicated
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` pair. It never stores credentials in
backend configuration. See [state setup](infra/cloudflare/README.md#r2-backed-terraform-state).

`CLOUDFLARE_API_TOKEN` authorizes deployment. `ACCESS_TOKEN` is a different secret
used to log in to the application. Live deployment reads both from your shell,
not `.dev.vars`. Terraform outputs generate `wrangler.deploy.json`; the checked-in
`wrangler.jsonc` always remains a local-development configuration.

## Email behavior

- All inboxes are virtual; no per-inbox registration is required.
- Inbox membership uses the SMTP envelope recipient. Headers are display data.
- Dots are removed and plus tags stripped when normalizing local parts.
- Raw MIME bytes are stored in R2 under a SHA-256 content ID; D1 indexes recipients.
- Received time for retention is the processing time, not a sender-controlled date.
- Default retention is one day. Reads hide expired records before physical cleanup.
- Deletion affects one inbox entry. Shared raw content remains until R2 expiry.
- Reserved aliases are unavailable as disposable inboxes. An optional verified
  private destination enables Terraform-managed forwarding for every configured
  reserved alias. Without it, reserved mail is rejected. See the deployment guide.

Cloudflare's inbound size limit is 25 MiB. Message parsing and repeated RSS parsing
also consume Worker CPU/memory; size limits alone are not a resource guarantee.

## API and production readiness

The [OpenAPI schema](docs/schema.yaml) documents inbox endpoints. Pass `type=json`
for JSON responses and use an `x-api-key` header, cookie, or query parameter when
private access is enabled. All inboxes share one instance-level access token.
Use the [deployed-instance checks](infra/cloudflare/README.md#verify-a-deployed-instance)
to verify the website and access control before sending real test messages.

Read [production readiness](docs/production-readiness.md) before public exposure.
The HTML viewer needs stronger content isolation; rate limits and daily quotas
are not implemented yet.

## License

MIT. See [LICENSE](LICENSE) for the copyright and license terms.
The package is marked private to prevent accidental
npm publication; the application source repository itself is public.
