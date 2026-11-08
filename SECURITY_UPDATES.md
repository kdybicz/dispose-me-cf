# Security Updates

Use this process for dependency security updates in Dispose Me - Cloudflare.

It covers application packages, build and deployment tooling, Node.js, Yarn, Terraform,
Terraform providers, and GitHub Actions.

## 1. Monthly and urgent updates

### Monthly maintenance

Once a month:

1. Review previously deferred advisories, temporary resolutions, and held-back upgrades.
2. Record the current dependency and audit baseline.
3. Update dependencies to the latest eligible stable releases, including major versions that
   do not require substantial migration work.
4. Audit the updated dependency tree.
5. Remediate remaining findings and document any deferrals.
6. Complete verification and summarize the changes in the pull request.

Group related upgrades so failures can be attributed and reverted easily.

If a major upgrade requires substantial application changes, build/test reconfiguration, or
new runtime requirements, track it separately. Record the reason and revisit condition under
[Held-back upgrades](#held-back-upgrades).

### Urgent updates

Between monthly runs, prioritize:

- High or critical vulnerabilities affecting deployed Worker code.
- Vulnerabilities affecting build or deployment tools where the affected behavior is used
  and could compromise credentials, generated artifacts, infrastructure, or deployment integrity.
- Lower-severity findings when project-specific exposure makes them urgent.

Keep the change focused on the affected dependency paths. Do not refresh the entire tree or
remove unrelated resolutions.

Use the smallest compatible release that fixes all known advisories for the affected package.
Prefer an in-range lockfile update where possible.

## 2. Project safeguards

- Use Node.js 24 and the Yarn version pinned in `package.json`.
- Keep `enableScripts: false` and `npmMinimalAgeGate: 7d` enabled.
- Do not bypass the age gate through environment variables or configuration changes.
- Do not add `npmPreapprovedPackages` entries without explicit user approval.
- Prefer direct dependency or parent upgrades over transitive resolutions.
- Never force an incompatible major version through a resolution.
- Do not manually edit `yarn.lock`, generated CSS, or generated templates.
- Keep tokens, email content, Terraform state, backend credentials, and generated deployment
  configuration out of commits and diagnostic output.

## 3. Establish the baseline

Inspect existing work before changing dependency files.

Run:

```bash
yarn install --immutable
yarn audit
yarn npm audit --recursive
```

`yarn audit` reports recursive high and critical findings. The unfiltered command also reports
lower-severity findings.

For each advisory, record:

- Advisory identifier, severity, and affected/fixed versions.
- Dependency path, confirmed with `yarn why <package>`.
- Actual project exposure.
- Whether a resolution selects the affected version.
- Available remediation or reason for deferral.

Use these exposure categories:

| Category | Project examples |
| --- | --- |
| Deployed Worker code | Express, postal-mime, sanitize-html, feed |
| Build and generated output | EJS, Tailwind, Wrangler's bundler |
| Deployment and infrastructure | aws4fetch, Wrangler, Terraform, Cloudflare provider |
| Local development and testing | Miniflare, Playwright, tsx, Biome |

A package's placement in `devDependencies` does not establish that a vulnerability is irrelevant.

For monthly maintenance, use the baseline as a comparison point; first update eligible
dependencies, then remediate what remains.

## 4. Update dependencies

### npm packages

For monthly updates, refresh transitive packages within existing ranges:

```bash
yarn up -R '**'
```

Then review and update direct dependencies in related groups.

- Read release notes and migration guides for major upgrades.
- Preserve intentional version-range and exact-pin conventions.
- Keep type packages compatible with their runtime packages.
- Evaluate ESM-only changes against the actual build and test runtime.
- Review `package.json` and `yarn.lock` after each group.

Reassess existing security resolutions individually. Remove one when the normal dependency
tree supplies a fixed version; confirm the resulting tree before keeping that removal.

When updating Biome, run:

```bash
yarn biome migrate --write
```

Review the resulting configuration changes.

### Runtime and infrastructure tools

Review Node.js, Yarn, Terraform, the Cloudflare provider, and GitHub Actions during monthly
maintenance.

When updating:

- **Node.js:** keep `.nvmrc`, package engines, CI, and relevant documentation consistent.
- **Yarn:** update the `packageManager` pin and any corresponding minimum-version declarations.
- **Terraform:** align `.terraform-version` and CI's Terraform version; review root version
  constraints.
- **Cloudflare provider:** update the intended constraints and `.terraform.lock.hcl` files
  across the affected Terraform roots.
- **GitHub Actions:** review release notes and permission changes.

Treat a Workers `compatibility_date` change as a separate runtime-behavior change, not an
automatic consequence of upgrading Wrangler.

Provider and deployment-tool upgrades must preserve Terraform/Wrangler ownership boundaries,
unrelated DNS records, and the private R2 state backend with independent keys and native
lockfiles.

## 5. Remediate remaining findings

After updating, rerun both audits and confirm remaining paths with `yarn why`.

Prefer, in order:

1. An in-range lockfile update.
2. A compatible direct dependency upgrade.
3. The nearest parent upgrade that supplies the fix.
4. A narrowly scoped resolution when no compatible parent upgrade supplies it.

For each resolution, document:

- Advisory and dependency path.
- Selected version and compatibility rationale.
- Why a parent upgrade cannot currently replace it.
- Removal condition.

Do not treat deprecation notices alone as security vulnerabilities.

## 6. Age-gate exceptions and deferrals

A release younger than seven days normally waits until it becomes eligible.

If an urgent security fix requires an exception, obtain explicit user approval before adding
an exact package/version entry:

```yaml
npmPreapprovedPackages:
  - 'package-name@1.2.3'
```

Record the reason and removal date. Remove it once the release has passed the age gate and
verify that the immutable installation still succeeds.

If no usable fix exists, record:

- Advisory and dependency path.
- Exposure and available mitigation.
- Why remediation is blocked.
- Follow-up action and next review date.
- Maintainer decision accepting the temporary deferral.

Keep findings visible. Do not weaken audit commands or add blanket exclusions to obtain a
passing result.

## 7. Verify

During iteration, run checks relevant to the changed behavior. If a check fails, iterate on
that check before rerunning the aggregate.

At the final checkpoint:

```bash
yarn install --immutable
make test
yarn audit
yarn npm audit --recursive
```

`make test` covers linting, unit/deployment tests, Worker type checking and dry-run bundling,
local Worker integration tests, and Terraform validation/mocked tests. It does not run the
dependency audits; run those explicitly as shown above.

Also run:

```bash
yarn test:browser
```

when changes can affect HTML sanitization, viewer isolation, templates, inline images, or
browser-facing security behavior.

Review the relevant existing coverage for:

- MIME parsing, charset handling, and byte-for-byte downloads.
- Authentication, reserved addresses, and recipient-specific access/deletion.
- Expiry and cleanup behavior.
- HTML isolation and resource authorization.
- Deployment credentials, state locking, and infrastructure ownership.

Use local resources and synthetic messages for routine verification. Record any additional
live verification required by a deployment-related change.

## 8. Pull request and acceptance criteria

Use the existing PR template. Include:

- Changed dependencies, separating deployed code from tooling.
- Major upgrades and compatibility conclusions.
- Baseline and final advisory results.
- Resolutions and approved age-gate exceptions.
- Deferred advisories and held-back upgrades.
- Verification results and deployment implications.

An update is ready when:

- The immutable installation and required verification pass.
- No unaccepted high or critical finding remains within scope.
- Monthly maintenance resolves lower-severity findings where compatible fixes exist.
- Any expected audit failure is explained by explicitly accepted, documented findings.
- Resolutions and preapprovals are necessary and narrowly scoped.
- The diff contains no unexplained lockfile churn, downgrade, or unrelated migration.

## 9. Maintenance records

Recheck both tables at every monthly update.

### Temporary resolutions and deferred advisories

The entries below preserve the previous maintenance notes. Their advisory status and fix
availability have not been revalidated as part of this documentation update.

| Advisory | Dependency path and exposure | Action or reason blocked | Removal/revisit condition |
| --- | --- | --- | --- |
| GHSA-wq5f-xc86-pv6w | `wrangler@4.148.0` → `miniflare@5.20261006.0-alpha` → `sharp@0.35.4`; local development tooling, not deployed Worker code. | Scoped resolution `miniflare@npm:5.20261006.0-alpha/sharp` selects compatible patch `0.35.5`. The previous note records publication on 2026-09-27 and age-gate eligibility. | Revalidate at the next dependency update. Remove when an eligible Wrangler/Miniflare release supplies the fix without the resolution. |
| GHSA-vfj7-8cjw-p6xm (high) | `@parcel/watcher@2.5.1` → `micromatch@4.0.8` → `braces@3.0.3`; build/local tooling. | The 2026-10-18 audit note records fixed version `3.0.4`, but the registry returned E404. Keep the finding visible rather than inventing an incompatible pin. | Recheck the advisory, parent releases, and fixed-version availability at the next dependency update. Record a current maintainer decision if deferral is still needed. |

### Held-back upgrades

| Package/tool | Held version or major | Reason and issue/decision | Revisit condition |
| --- | --- | --- | --- |

No held-back upgrades are recorded yet.
