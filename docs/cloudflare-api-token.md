# Cloudflare API token setup

Create one custom user API token for the Dispose Me - Cloudflare deployment.
Terraform and Wrangler both read it from `CLOUDFLARE_API_TOKEN`.

This guide covers the resources currently declared in `infra/cloudflare/` and
the application deployment in `cloudflare/deployment.mjs`, using Cloudflare
provider 5.27.0 and Wrangler 4.148.0. The permissions below cover provisioning,
deployment, and optional domain administration.

## 1. Identify the account and domain

In the Cloudflare dashboard, select the account containing your test domain.
Find its [account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)
and use that ID as `account_id` in
`infra/cloudflare/storage/terraform.tfvars`.

The domain must already be an active Cloudflare DNS zone in that account. R2
must also be activated in the account through **R2 Object Storage** in the
Cloudflare dashboard. Complete its onboarding/billing flow until the bucket
overview is available, even if you intend to stay within the free allowance.
Terraform will create the application's bucket afterward. See
[R2 activation](../infra/cloudflare/README.md#activate-r2-before-provisioning)
for the steps and how to resume a partially completed apply.

Domain registration, nameserver changes, and R2 billing activation are
dashboard/registrar setup steps; this token does not perform them.

## 2. Create a custom token

1. Open [My Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens).
2. Select **Create Token**.
3. Choose **Create Custom Token > Get started**.
4. Name it something recognizable, such as `dispose-me-cf-deployment`.
5. Add the nine permission entries below.

### Account permissions

| Scope | Permission | Access | Used for |
| --- | --- | --- | --- |
| Account | Account Settings | Read | Wrangler account metadata and deployment checks. |
| Account | Workers Scripts | Edit | Worker code, bindings, static-asset upload sessions, secrets, cron triggers, `workers.dev`, and the Terraform-managed Worker custom domain. |
| Account | Workers R2 Storage | Edit | Terraform bucket/lifecycle management and R2-backed state, including state-bucket bootstrap. |
| Account | D1 | Edit | Terraform database creation/refresh and Wrangler remote schema migrations. |

### Zone permissions

| Scope | Permission | Access | Used for |
| --- | --- | --- | --- |
| Zone | Zone | Read | Resolve the domain's zone ID and check its account, name, and active status. |
| Zone | Zone Settings | Edit | Enable managed Email Routing DNS and the zone-wide HTTPS redirect. |
| Zone | Email Routing Rules | Edit | Configure the Worker catch-all and optional reserved-address forwarding rules. |
| Zone | DNS | Edit | Publish the DMARC TXT record and proxied www CNAME. |
| Zone | Single Redirect | Edit | Manage the www-to-apex canonical redirect. |

Cloudflare's API documentation sometimes calls the write permissions `Write`;
the dashboard also uses `Edit` for these permission groups. Select the write/edit
level. Edit includes the corresponding read/list operations, so separate Read
entries for those same groups are unnecessary.

For live CLI logs, optionally add **Account > Workers Tail > Read**. It is used
by `yarn wrangler tail --config wrangler.deploy.json`, not by provisioning.

The current configuration uses the Worker custom-domain API, authorized by
Workers Scripts Edit, rather than zone Worker routes. It enables managed mail
MX/SPF/DKIM through Zone Settings Edit. The separate DMARC record uses DNS Edit.
The www redirect uses Single Redirect Edit, also called Dynamic URL Redirects Write
in the API permission reference. Bulk redirect permissions are unnecessary.
**Workers Routes Edit** is not needed for this configuration.

### Direct DNS record access

DNS Edit is required for DMARC and the www CNAME. It also allows inspecting and removing records
that cause custom-domain creation to fail with HTTP 409 / Cloudflare error
`100117` about externally managed DNS records. Workers Scripts Edit and Zone
Settings Edit do not grant direct
DNS-record access. DNS Edit includes read access, so DNS Read alone is insufficient
when the deployment operator needs to remove a conflicting record.

Before removing a conflicting record,
confirm its exact hostname and purpose. Preserve unrelated hostnames, MX, SPF,
DKIM, DMARC, and verification records. Once cleared, rerun the routing apply so
Terraform creates the managed custom-domain binding. Import an existing DMARC
record before applying rather than creating a second policy record.

### Email forwarding destinations

Inspecting verified forwarding destinations requires **Account > Email Routing
Addresses > Read**. Registering a destination requires **Account > Email Routing
Addresses > Edit**, which also includes read access. Cloudflare sends a
verification email that the destination mailbox owner must confirm.

The provisioning flow does not create destination mailboxes. Set
`reserved_forward_to` in the local storage inputs to an already verified private
address. Terraform then creates literal forwarding rules for every reserved alias;
mail matching those rules bypasses the disposable Worker and storage. The Worker
still rejects reserved dot/plus variants that reach the catch-all. The deployment
token's user or account name does not select the private mailbox automatically.

## 3. Restrict the resources

Set both resource selectors:

- **Account Resources:** Include > Specific account > your selected account.
- **Zone Resources:** Include > Specific zone > your test domain.

The selected account must match `account_id`, and the selected zone must match
`domain_name` in `infra/cloudflare/storage/terraform.tfvars`.

Account permissions apply to the selected account's resources. Restricting the
zone does not restrict Workers, databases, or buckets to this application's
resource names. This token can manage other resources covered by those account
permissions too.

User Details, Memberships, API Tokens administration, Billing Edit, Cloudflare
Pages, Workers KV, and Email Routing Addresses are not used by this provisioning
workflow. The application routes mail into a Worker without creating a forwarding
destination address. For R2 Terraform state, the helper can derive S3-compatible
credentials from this R2-capable API token, using its verified token ID and the
SHA-256 hash of its value. A separately generated R2 key pair is optional.

If you add IP filtering or an expiration date, ensure they cover the machine and
period you will deploy from. Select **Continue to summary**, review the account,
zone, and permissions, then select **Create Token**. Save the token in your
password manager; Cloudflare displays its value only once.

## 4. Load the token into your shell

From a Bash terminal, enter the token at a hidden prompt:

```bash
read -r -s -p 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
```

This avoids putting the literal token into your command history. A secret manager
that exports environment variables is another suitable source. Both Terraform
and Wrangler inherit the exported value. No `wrangler login` is required when
using this API token.

Use the exported environment variable for deployment. Terraform does not
automatically load the repository's `.env` or `.dev.vars` files, and the deployment
script disables Wrangler's loading of `.env` development values. Keep the API
token out of Terraform variables, generated Wrangler configuration, and Git.

There are two different credentials:

| Variable | Purpose | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Authorize Terraform and Wrangler against Cloudflare. | The token generated by Cloudflare. |
| `ACCESS_TOKEN` | Log in to the deployed disposable email application. | A separate token you choose, with 20-50 alphanumeric characters. |
| `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` | Optional narrower credentials for Terraform state. | A paired R2 Object Read & Write key scoped to the dedicated state bucket. |

Do not use the Cloudflare API token as the application login token. Cloudflare's
token format can contain prefixes and punctuation; the application's alphanumeric
length restriction does not apply to `CLOUDFLARE_API_TOKEN`.

For first-time state setup, export `CLOUDFLARE_ACCOUNT_ID` with the account ID and
run `yarn state:bootstrap`. The generated `.terraform-state.json` contains only
account/bucket/key-prefix settings. Credentials are never written into it or the
generated Terraform backend configuration. S3-compatible backend credentials
are supplied only to Terraform child processes and point to Cloudflare R2. See
[R2 state setup](../infra/cloudflare/README.md#r2-backed-terraform-state).

## 5. Verify the token

Run this read-only check from the same terminal. Node reads the token from the
environment, so it is not embedded in the command's arguments or printed:

```bash
node --input-type=module -e '
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set");
  const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!response.ok || !body.success || body.result?.status !== "active") {
    throw new Error("Cloudflare token verification failed; check its value, expiry, and IP filter");
  }
  process.stdout.write("Cloudflare API token is active.\n");
'
```

An active result verifies the token itself, not every resource permission.
Terraform plans exercise resource reads, while apply/deploy exercise writes.
Likewise, a Wrangler deployment dry run builds locally and does not prove that
the token can upload a Worker.

Continue with [the infrastructure deployment guide](../infra/cloudflare/README.md#first-deployment).
That workflow provisions storage, deploys the Worker and application login
secret, then connects the web domain and catch-all mail routing.

When finished with the session, remove the credentials from your shell:

```bash
unset CLOUDFLARE_API_TOKEN ACCESS_TOKEN
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Token verification fails | Copy the token value, not its ID/name. Check expiry and client-IP restrictions. |
| Token is active, but the zone lookup fails | Zone Read, Specific zone selection, and the account/domain in `terraform.tfvars` must match. |
| D1 creation or remote migrations fail with an authorization error | Account > D1 > Edit and the selected account. |
| R2 creation or lifecycle updates fail | Account > Workers R2 Storage > Edit, selected account, and R2 activation. An inactive R2 subscription is a separate issue from token permissions. |
| Worker, assets, secrets, or custom-domain operations are forbidden | Account > Workers Scripts > Edit and the account ID in the generated deployment configuration. |
| Custom domain fails with HTTP 409 / error `100117` | Resolve conflicting A/AAAA/CNAME records for that hostname. Add Zone > DNS > Edit if doing this through the API; Workers Scripts Edit alone cannot remove them. |
| Configured domain redirects to another website | Inspect Cloudflare's Single/Bulk Redirect rules. Additional redirect-rule permissions may be required. |
| Listing or creating forwarding destinations is forbidden | Account > Email Routing Addresses > Read or Edit, respectively. Zone-level Email Routing Rules Edit does not grant this account-level permission. |
| Email Routing DNS setup is forbidden | Zone > Zone Settings > Edit. Email Routing Rules Edit alone is insufficient for this endpoint. |
| Catch-all updates are forbidden | Zone > Email Routing Rules > Edit for the selected zone. |
| `wrangler tail` is forbidden | Add the optional Account > Workers Tail > Read permission. |

Resolve the missing permission or resource scope shown by the failed operation.
A valid token cannot fix conflicting MX records, an inactive DNS zone, or
Cloudflare account-onboarding requirements. `wrangler whoami` may request extra
user-profile/membership permissions; the verification command above avoids
requiring them for this deployment workflow.

## References

- [Create a Cloudflare API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Wrangler environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)
- [Attach a Worker custom domain](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)
- [Enable Email Routing and its managed DNS records](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/)
