# November 2026 security updates

Monthly maintenance performed on 2026-11-08 using Node.js 24.22.2 and Yarn 4.18.1.
Follow [Security Updates](../SECURITY_UPDATES.md) for the maintenance process.

## Dependency changes

All selected direct npm releases were at least seven days old. Install scripts remained
disabled and no age-gate exceptions were added.

| Dependency | Previous | Selected | Exposure |
| --- | --- | --- | --- |
| express | 5.2.1 | 5.3.0 | Deployed HTTP handling |
| feed | 4.2.2 | 6.0.0 | Deployed RSS generation; major upgrade |
| postal-mime | 4.0.4 | 4.2.0 | Deployed MIME parsing |
| sanitize-html | 2.18.0 | 2.18.1 | Deployed email HTML sanitization |
| @biomejs/biome | 2.5.15 | 2.6.4 | Development checks; configuration migrated with `yarn biome migrate --write` |
| @cloudflare/workers-types | 5.20261006.1 | 5.20261101.1 | Worker type checking |
| @types/node | 24.19.1 | 24.19.2 | Type checking; keep aligned with Node.js 24 |
| ejs | 6.0.1 | 7.0.2 | Build-time template compilation; major upgrade |
| glob | 13.0.6 | 14.0.3 | Build-time template discovery; major upgrade |
| playwright | 1.64.0 | 1.64.1 | Browser regression testing |
| wrangler | 4.148.0 | 4.156.0 | Build, local runtime, and credential-handling deployment tooling |

The monthly lockfile refresh also updates eligible transitive packages. Wrangler and tsx now
share esbuild 0.28.2 instead of retaining both 0.28.1 and 0.28.2.

### Major-version compatibility review

- **Feed 6:** reviewed the [5.0 release](https://github.com/jpmonette/feed/releases/tag/5.0.0)
  and [6.0 changes](https://github.com/jpmonette/feed/pull/252). The project uses the named
  `Feed` API and runs on Node.js 24, satisfying the newer runtime requirement. Existing RSS
  content and resource-budget tests passed without application changes.
- **EJS 7:** reviewed the
  [migration notes](https://github.com/mde/ejs/blob/v7.0.2/notes/RELEASE_NOTES_v7.md).
  The project does not use the changed CLI or Express options-in-data behavior. Its explicit
  build-time `Template` compilation works without changes; templates remain precompiled for
  Workers.
- **Glob 14:** reviewed the
  [changelog](https://github.com/isaacs/node-glob/blob/v14.0.3/changelog.md). The project uses
  the supported `glob()` API with a fixed repository-owned pattern. The changed internal
  pattern/walker APIs are not used; template discovery and the build passed.
- **TypeScript 7:** reviewed the
  [migration guide](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
  and tried 7.0.2. `yarn typecheck` failed with TS5108 because the current configuration sets
  `esModuleInterop=false`. Restored 5.9.3 and recorded a separate migration follow-up in
  [Held-back upgrades](../SECURITY_UPDATES.md#held-back-upgrades).

## Advisory remediation

The immutable baseline installation succeeded. Both the high-severity and unfiltered
recursive audits initially reported findings. The updated tree reports none.

Dependency paths were checked with `yarn why` before and after the updates.

| Advisory | Severity | Baseline dependency path and version | Remediation |
| --- | --- | --- | --- |
| [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) | High | express → body-parser 2.3.0; deployed code, affected `<2.4.0` on the 2.x line | body-parser 2.4.0 through express 5.3.0 |
| [GHSA-f2hq-32vh-53cc](https://github.com/advisories/GHSA-f2hq-32vh-53cc) | High | postal-mime 4.0.4; deployed code, affected `>=3.0.0 <4.0.8` | postal-mime 4.2.0 |
| [GHSA-c9rx-x947-fp3h](https://github.com/advisories/GHSA-c9rx-x947-fp3h) | Moderate | sanitize-html 2.18.0; deployed code, affected `>=2.18.0 <2.18.1` | sanitize-html 2.18.1 |
| [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) | Low | sanitize-html → deepmerge 4.3.1; deployed dependency, affected `>=4.2.0 <=4.3.1` | sanitize-html 2.18.1 removes deepmerge |
| [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) | Moderate | express/body-parser → qs 6.16.0; deployed dependency, affected `>=6.7.0 <=6.16.0` | qs 6.17.1 through compatible parent ranges |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) | Moderate | glob 13.0.6; build tooling, affected `>=9.0.0 <=14.0.1` | glob 14.0.3 |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Moderate | glob → minimatch 10.2.6; build tooling, affected `>=7.0.0 <11.0.1` | glob 14.0.3 supplies minimatch 11.0.3 |

### Undici findings

The baseline contained Undici 7.29.1 through Wrangler → Miniflare and 8.11.2 through
node-gyp. These are tooling dependencies, not application imports. The refreshed tree selects
7.30.1 through the updated Wrangler/Miniflare and 8.12.3 within node-gyp's existing range.
Both meet the fixed-version floors of 7.30.1 and 8.12.2 for these findings:

| Advisory | Severity |
| --- | --- |
| [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | High |
| [GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26) | High |
| [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) | High |
| [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) | High |
| [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) | Moderate |
| [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) | Moderate |
| [GHSA-9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6) | Moderate |
| [GHSA-55wc-3pg8-jfw6](https://github.com/advisories/GHSA-55wc-3pg8-jfw6) | Moderate |

### Previous maintenance records

- Removed the sharp resolution for
  [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).
  Wrangler 4.156.0 → Miniflare 5.20261023.3-beta pins fixed sharp 0.35.5 directly.
- Closed the deferred braces record for
  [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): GitHub records
  its withdrawal on 2026-10-23. The @parcel/watcher → micromatch → braces 3.0.3 path still
  exists; closure reflects the withdrawal, not an invented fixed release or an exclusion.

## Runtime, infrastructure, and CI

- Node.js 24.22.2 and Yarn 4.18.1 were already the latest stable releases in the project's
  supported lines. Node.js 26 and its type definitions are outside the declared Node.js 24
  runtime contract.
- Updated Terraform 1.13.3 → 1.17.1 in `.terraform-version`, CI, and documentation. Reviewed
  the intervening minor-release notes and retained the existing compatible root constraints.
- Updated the Cloudflare provider 5.27.0 → 5.28.1 in all three roots and regenerated each
  provider lockfile using isolated metadata with `init -backend=false -upgrade`.
  The 5.28 breaking changes concern resources this project does not use. Version 5.28.1
  includes the upstream compromised-CA distrust update; Terraform 1.17 also includes that
  trust-store hardening.
- Updated actions/checkout v6 → v7, actions/setup-node v6 → v7, and
  hashicorp/setup-terraform v3 → v4 after reviewing their release notes and Node.js 24 action
  runtime requirements. The existing GitHub-hosted `ubuntu-latest` jobs meet those requirements.
  Workflow inputs, triggers, and permissions are preserved. CodeQL remains on its current v4
  major tag.
- Worker `compatibility_date`, infrastructure resources, backend configuration, and D1 schema
  are unchanged. A live deployment still requires review of the provider's refresh/plan
  against the target environment and the normal HTTPS/SMTP acceptance checks.

## Releases waiting for the npm age gate

These were the latest releases when checked on 2026-11-08. Recheck the registry and
seven-day eligibility at the next update; no exception was requested or added.

| Package | Selected | Newer latest release | Publication date (UTC) |
| --- | --- | --- | --- |
| @biomejs/biome | 2.6.4 | 2.6.6 | 2026-11-06 |
| @cloudflare/workers-types | 5.20261101.1 | 5.20261108.1 | 2026-11-08 |
| @tailwindcss/cli | 4.3.3 | 4.3.5 | 2026-11-06 |
| glob | 14.0.3 | 14.0.4 | 2026-11-06 |
| playwright | 1.64.1 | 1.65.0 | 2026-11-05 |
| wrangler | 4.156.0 | 4.158.0 | 2026-11-05 |

## Verification

Passed on the final dependency tree:

- `yarn install --immutable`.
- `make test`: lint, 44 unit tests, 19 deployment/state-helper tests, Worker type checking
  and dry-run bundling, local Worker integration smoke tests, and 10 mocked Terraform tests
  across the state, storage, and routing roots.
- `yarn test:browser`: local Chromium regression coverage, including sandbox isolation and
  multi-megabyte inline image decoding, using the existing cached browser installation.
- `yarn audit` and `yarn npm audit --recursive`: both report no audit suggestions.
- `git diff --check` and the agent-instructions audit.

Local verification used Terraform 1.17.1 and a writable temporary Wrangler configuration
directory. No live infrastructure was applied and no email was sent to a public domain.
The changed GitHub Actions versions require verification on GitHub when the branch is pushed.

## Live deployment

Deployed to `https://disposeme.de` on 2026-11-08. Worker version
`768408ba-5538-4ddd-be1e-0d6d6139a530` was confirmed active at 100% traffic.

- The deployment dry run passed and remote D1 reported no pending migrations.
- The existing `ACCESS_TOKEN` secret was preserved by running Wrangler's remote migration
  and deploy commands without a secret upload. The application token was not present in the
  deployment shell; its value was neither retrieved nor replaced.
- Initialized the deployment roots with the selected provider and existing R2 backend.
  Live plans for state, storage, and routing all reported no changes; no infrastructure apply
  was needed.
- Verified the HTTPS application page and CSS return 200, and the private inbox returns 403
  with missing or invalid credentials. HTTP and www return the expected permanent canonical
  redirects, preserving the path and query string.
- Confirmed the existing secret binding, query-string log-redaction setting, and all three
  public Cloudflare MX records.

Authenticated inbox operations and real SMTP delivery were not exercised in this deployment
session. A synthetic query-credential request was rejected with 403, but the persisted-log
query also returned 403 because the deployment credential lacks Workers Observability Write;
persisted-event redaction verification remains unconfirmed.
