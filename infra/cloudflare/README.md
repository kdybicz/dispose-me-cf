# Cloudflare infrastructure and deployment

Terraform 1.13.3 and Cloudflare provider 5.27.0 provision the service. Wrangler
builds and deploys its Worker.

| Owner | Resources |
| --- | --- |
| Terraform state root | Dedicated private R2 state bucket, protected from accidental destruction |
| Terraform storage root | D1 database, R2 bucket, lifecycle retention, domain lookup, deployment outputs |
| Terraform routing root | Worker custom domain/TLS, HTTPS enforcement, www redirect/DNS, Email Routing DNS, reject DMARC policy, catch-all, optional reserved-address forwarding |
| Wrangler | Worker code, static assets, bindings, cron schedule, secrets, D1 schema migrations |

Do not put `routes`, `addresses`, or Wrangler environments in the local config:
generated configuration rejects them because Terraform owns routing.

## Prerequisites

- An existing Cloudflare DNS zone for the domain in your account. Storage can be
  prepared while zone activation is pending; routing requires an active zone.
- [The deployment API token](../../docs/cloudflare-api-token.md), exported as
  `CLOUDFLARE_API_TOKEN` in the shell running Terraform and Wrangler.
- R2 activated in that same Cloudflare account.
- A separate 20-50-character alphanumeric `ACCESS_TOKEN` for private application access.

Domain registration can remain with your current registrar. Delegate DNS to the
nameservers assigned by Cloudflare and wait for the zone overview to show **Active**.
Use **Check nameservers** in the overview if activation is still pending. Public
resolvers may cache earlier answers during propagation.

### Activate R2 before provisioning

Select the account in Cloudflare, open **R2 Object Storage**, and complete the
activation/onboarding flow. Supply billing details and accept subscription terms
if prompted. Continue until the bucket overview offers bucket creation. This is
required even for usage within the free allowance; API-token permissions alone
do not activate R2. Terraform creates the bucket afterward.

Without activation, creation returns HTTP 403 / error `10042`, `Please enable R2
through the Cloudflare Dashboard.` Complete activation and rerun `yarn infra
storage apply`; resources already recorded in state are retained.

## R2-backed Terraform state

All three roots use Terraform's S3-compatible backend pointed exclusively at
Cloudflare R2. The default bucket is
`dispose-me-cf-terraform-state`, with independent object keys:

```text
dispose-me-cf/state.tfstate
dispose-me-cf/storage.tfstate
dispose-me-cf/routing.tfstate
```

Native lock files use the same keys with a `.tflock` suffix. The helper sets
`use_lockfile=true`; R2 atomically enforces `If-None-Match: *`. The bootstrap checks
competing conditional writes and removes its temporary probe. Credential discovery,
metadata-service requests, and region validation are disabled. The S3-compatible
backend receives its credentials through process environment variables and connects
only to the configured R2 endpoint.

### Bootstrap the state bucket once

Export `CLOUDFLARE_API_TOKEN` with Workers R2 Storage Edit and the account ID:

```bash
export CLOUDFLARE_ACCOUNT_ID="YOUR_CLOUDFLARE_ACCOUNT_ID"
yarn state:bootstrap
```

The command creates a dedicated Standard R2 bucket if needed, verifies public
access is disabled and there are no state-expiration rules, tests conditional
writes, and imports the bucket into a separate Terraform state root. That root
stores its own state in the bucket and declares `prevent_destroy`. It is separate
from application/email resources and is not deleted when they are decommissioned.

Bootstrap generates ignored `.terraform-state.json` with only the non-secret
account/bucket/key-prefix connection settings. Override the bucket or key prefix
with `TF_STATE_BUCKET` / `TF_STATE_PREFIX`; use a distinct
prefix and application resource prefix for each environment.

By default, the helper verifies the existing Cloudflare deployment token, then
derives R2 S3 credentials as Cloudflare documents: token ID for the access key ID,
and SHA-256 of the token value for the secret key. The existing R2 Storage Edit
permission includes object operations. These credentials are held in memory and
passed only through the Terraform child process environment.

For narrower state access, export a dedicated R2 key pair with Object Read & Write
access to this bucket as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Supply both.
The regular Cloudflare API token is still used to manage infrastructure. Dedicated
R2 credentials take precedence; unrelated existing credentials/profiles are
never reused. Bootstrap itself needs the management token to create/check the bucket.

Git ignores state, plans, backend caches, local inputs, and generated connection
configuration. Provider lock files are versioned. Credentials never belong in a
backend file or Terraform input. The helper selects the default workspace; object
keys, not implicit workspaces, separate the three roots.

Initialize application roots after bootstrap. On a machine with the same checked-in
code and connection settings, the same token/key permissions access the same remote
state. Keep private backups as well: R2 does not implement S3 bucket versioning.
There is no email-retention policy on the state bucket.

Use the same credential-aware wrapper to export a private backup, for example
`yarn infra storage state pull > /private/backup/storage.tfstate.json`; repeat
for routing and the state root. Keep those files outside Git and public storage.

### Existing local state

If an environment already has actual local Terraform state, back it up and run
`yarn infra storage init -migrate-state` and the corresponding routing command.
Review Terraform's migration prompts; do not initialize an unrelated empty remote
state and recreate resources. When changing an existing R2 bucket/key prefix,
use the same explicit migration process. The helper refuses non-init commands
when their initialized backend target differs from the current connection settings.
For an existing R2 deployment, migrate all three roots, including the state root.
Treat the state bucket itself as long-lived; moving to a different bucket also
requires deliberate adoption of that bucket's Terraform resource, not an automatic
rename of the protected existing bucket.

## First deployment

1. From the repository root, create the local infrastructure inputs:

   ```bash
   cp infra/cloudflare/storage/terraform.tfvars.example infra/cloudflare/storage/terraform.tfvars
   ```

   Edit that file and set:

   ```hcl
   account_id      = "YOUR_CLOUDFLARE_ACCOUNT_ID"
   domain_name     = "example.com"
   resource_prefix = "dispose-me-cf"
   email_ttl_days  = 1
   ```

   Replace the example domain and account ID with your Cloudflare zone and account.

2. Bootstrap R2 state as above, then provision storage from the repository root:

   ```bash
   yarn infra storage init
   yarn infra storage plan
   yarn infra storage apply
   ```

3. Generate configuration and build the provisioned Worker without mutations:

   ```bash
   yarn config
   yarn deploy --dry-run
   ```

   Outputs supply the account, zone, database, and bucket IDs/names to generated
   `wrangler.deploy.json` and `.wrangler/deploy/routing.tfvars.json`. There is no
   manual copying of IDs and no secret in those files.

4. Export `ACCESS_TOKEN` through your secret manager or a hidden Bash prompt:

   ```bash
   read -r -s -p 'Application access token: ' ACCESS_TOKEN
   export ACCESS_TOKEN
   yarn deploy
   ```

   The command refreshes configuration, applies remote D1 migrations, uploads the
   Worker and CSS assets, and uploads the login secret via stdin. Keep the same
   token available for subsequent deployments. Schema migrations must remain
   compatible with the previously deployed code during this sequence.

5. Review the domain's existing records, then apply routing:

   ```bash
   yarn infra routing init
   yarn infra routing plan
   yarn infra routing apply
   ```

   Routing needs a local record of a successful Worker deployment matching the
   current storage/configuration. A dry run does not create that record. The custom
   domain must exist before Email Routing is enabled and the catch-all attached.
   Terraform also enables the zone-wide **Always Use HTTPS** setting, so HTTP
   navigation redirects to HTTPS. Use HTTPS directly for authenticated API calls.
   Both HTTP and HTTPS requests to `www` redirect permanently to the HTTPS apex,
   preserving the path and query string.
   See [existing domain records and rules](#existing-domain-records-and-rules)
   for configuration conflicts.

6. Check HTTPS without following redirects, authenticate, and send real test mail.
   Exercise Bcc, multiple recipients, binary attachments, raw downloads, reserved
   forwarding, and retention. DNS configuration alone does not prove delivery.

## DNS records managed by the setup

A fresh domain does not need manually created web A/AAAA/CNAME or mail records
before routing apply. Terraform uses Cloudflare's managed APIs to create them:

| Record | Purpose |
| --- | --- |
| Managed proxied apex record | Connects the custom domain to the Worker. Cloudflare may represent it as an AAAA record with `100::`; keep this managed record. |
| Proxied `www` CNAME | Sends www traffic through Cloudflare's canonical redirect to the apex domain. |
| Three Cloudflare MX records | Receive incoming email through Email Routing. |
| Apex SPF TXT record | Authorizes Cloudflare's routing service. |
| Cloudflare-selected DKIM TXT record | Authenticates routed/forwarded mail; its selector is managed by Cloudflare. |
| `_dmarc` TXT record | Terraform-managed `v=DMARC1; p=reject; sp=reject;` policy. |
| SOA and authoritative nameservers | Zone metadata managed automatically by Cloudflare. |

DMARC requests rejection of messages claiming this domain or its subdomains when
they fail DMARC authentication. It does not reject ordinary incoming messages
from other domains. No aggregate-reporting address is configured by default.
Terraform includes explicit outer quotation marks in the TXT content to avoid
Cloudflare's dashboard formatting warning; the effective DMARC policy is unchanged.
Before adding legitimate outbound senders, configure their aligned SPF/DKIM and
review this policy. Import an existing DMARC record before applying:

```bash
yarn infra routing import cloudflare_dns_record.dmarc ZONE_ID/DNS_RECORD_ID
```

DNSSEC remains a separate setup step; see
[production readiness](../../docs/production-readiness.md).

## Verify a deployed instance

Export the application token in the same shell and replace the example URL with
your configured HTTPS domain:

```bash
export APP_URL="https://example.com"
node --input-type=module -e '
  if (!process.env.ACCESS_TOKEN) throw new Error("ACCESS_TOKEN is required");
  const base = new URL(process.env.APP_URL);
  if (base.protocol !== "https:") throw new Error("Use an HTTPS application URL");
  for (const [path, expected, authenticated] of [
    ["/", 200, false],
    ["/assets/css/output.css", 200, false],
    ["/inbox?type=json", 403, false],
    ["/inbox?type=json", 200, true],
  ]) {
    const response = await fetch(new URL(path, base), {
      redirect: "manual",
      headers: authenticated ? { "x-api-key": process.env.ACCESS_TOKEN } : {},
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.text();
    if (response.status !== expected || (path === "/" && !body.includes("Dispose Me - Cloudflare"))) {
      throw new Error(`Unexpected application response for ${path}: ${response.status}`);
    }
    process.stdout.write(`${path}: ${response.status}\n`);
  }
'
```

This assumes the default `private_access = true`. HTTP requests without credentials
should receive a 301 redirect to the equivalent HTTPS URL. Check public MX/SPF/DKIM
records and the destination/rule status in Cloudflare, then send real email from
your normal mailbox to a disposable inbox and a reserved alias. Verify inbox
retrieval and receipt in the private forwarding mailbox. API/DNS checks alone do
not confirm that a real SMTP message was accepted and delivered.

## Reserved-address forwarding

To forward reserved mail privately, first add and verify the destination in
Cloudflare **Email Routing > Destination addresses**. The owner must click the
verification email. Then set this in the local storage inputs:

```hcl
reserved_forward_to = "owner@example.net"
```

Run storage plan/apply, deploy, then routing plan/apply. Terraform creates one
literal forwarding rule per `inbox_blacklist` entry, covering all nine defaults.
These rules precede the disposable catch-all, so matching messages never enter
the Worker or its D1/R2 storage. The UI/API still disallows those inboxes.

The destination is intentionally explicit, not inferred from an account profile.
It must be outside the disposable domain. `null`, the default, creates no private
forwarding rules and the Worker rejects reserved addresses. Dot/plus variants
normalize to reserved usernames and are rejected by the Worker; only the literal
reserved aliases are forwarded by these Cloudflare rules.

Import existing literal rules before applying to a previously configured zone:

```bash
yarn infra routing import \
  'cloudflare_email_routing_rule.reserved["postmaster"]' ZONE_ID/RULE_ID
```

## Existing domain records and rules

An existing A/AAAA/CNAME at the application hostname can block custom-domain
creation with HTTP 409 / error `100117`. After confirming its purpose and the intended change,
remove only the conflicting web record. API-based removal requires the conditional
Zone DNS Edit permission, which is also required for DMARC. Preserve other hostnames, mail authentication, and
verification records. Cloudflare manages the new custom-domain DNS and TLS.

Existing Single/Bulk Redirect rules can execute before the Worker. Narrow the
matching rule to exclude the application hostname instead of disabling redirects
for unrelated hostnames. A final HTTP 200 from another website is not a successful
application check. See the
[token troubleshooting guide](../../docs/cloudflare-api-token.md#troubleshooting)
if additional redirect-rule permissions are needed.

The routing root owns the zone's `http_request_dynamic_redirect` entry-point
ruleset for the www redirect. A zone can have only one entry-point ruleset for
that phase. If one already exists, import it and include any rules you need to
preserve in the Terraform configuration before applying; do not replace it blindly.

If Cloudflare Email Routing is already enabled, initialize this routing root,
generate config, and import its settings and catch-all before applying:

```bash
yarn infra routing import \
  cloudflare_email_routing_dns.inbox ZONE_ID
yarn infra routing import \
  cloudflare_email_routing_catch_all.inbox ZONE_ID
```

The root apex omits the optional Email Routing `name`; the pinned provider otherwise
attempts a subdomain PATCH on imported configurations. D1 replication explicitly
matches the API's disabled default to avoid an invalid null update.

R2 lifecycle configuration replaces the bucket's complete rule set and cannot be
imported with this provider. The provider also warns that lifecycle/catch-all/zone-setting
resources cannot be destroyed through Terraform. Review removal behavior before
decommissioning; do not assume `terraform destroy` removes everything.

## Verification and CI

`make test` validates all three roots with the mocked provider and runs the same
local application checks as CI. It uses isolated Terraform metadata directories
under `.wrangler/terraform-validation`, plus `-backend=false`, and does not read or
write live state or reuse initialized deployment backend caches. Live deployment runners need the same `.terraform-state.json`
connection values and secret environment credentials, then their own backend init.
The remote locks coordinate access across machines; serialize the complete
storage/deployment/routing workflow per environment as well.

An R2 Standard state bucket would likely cost $0/month within remaining account
free allowance. As checked on 2026-10-18, that allowance is 10 GB-month, one million
Class A operations, and ten million Class B operations monthly, shared with email
storage. Above it: $0.015/GB-month, $4.50/million Class A operations, and $0.36/million
Class B operations, with billing-unit rounding. Use a separate state bucket with
no email-expiration rule. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
