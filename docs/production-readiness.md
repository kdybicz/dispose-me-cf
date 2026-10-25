# Production readiness

The local integration suite and mocked infrastructure tests verify application
behavior without deploying resources. Production acceptance also requires live
HTTPS and SMTP checks on the configured domain.

## Application and domain security

- **Email HTML isolation.** The viewer sanitizes HTML and uses an opaque-origin
  sandboxed iframe with a restrictive document CSP. Scripts, forms, nested
  frames, SVG, sender CSS, and remote images are removed. Only supported CID raster
  images receive authenticated same-origin URLs. Opt-in local Chromium regression
  coverage (`yarn test:browser`, excluded from CI) verifies isolation and
  multi-megabyte image decoding. The frame scrolls rather
  than allowing parent DOM access for automatic height measurement. API `body`
  remains untrusted original parsed HTML; consumers must isolate it themselves.
  Resource URLs in the viewer carry the instance token because opaque frames
  cannot rely on SameSite cookies. They are not public URLs; each request checks
  authentication and unexpired inbox membership. Do not log query credentials.
  Sanitized links use `target="_blank"` and `rel="noopener noreferrer"`.
  Only `allow-popups allow-popups-to-escape-sandbox` are granted: clicked
  destinations can run normally in separate tabs, without an opener or referrer.
  Email scripts, same-origin access, and top-level navigation remain disabled.
- **DMARC policy.** Terraform publishes `p=reject; sp=reject`. Configure aligned
  authentication before using the domain with legitimate outbound senders, and
  choose a monitored reporting destination if aggregate reports are needed.
  Cloudflare-managed routing DKIM does not authenticate arbitrary incoming senders
  on behalf of the application domain.
- **DNSSEC.** Coordinate zone signing with registrar DS publication and verify
  the public chain of trust.
- **Domain verification.** Check public DNS, TLS, and routing targets after
  deployment. A final HTTP 200 at a different redirect destination is not a
  successful application check.
- **Rate limits and quotas.** Define and test instance/token/IP limits, concurrent
  enforcement, reset behavior, and platform costs. These controls are not yet
  implemented.

## Operational checks

- Define recovery for separate R2/D1 ingestion writes and verify SMTP retry behavior.
- RSS loads messages sequentially, retains only bounded feed-item data, and rejects
  over-budget feeds explicitly (25 MiB cumulative source MIME, 1 MiB item data,
  2 MiB XML). Raw MIME downloads stream with backpressure and cancellation.
  [Private parsed storage](email-storage.md) avoids repeated MIME parsing for warm
  message, image, attachment, and RSS reads; old messages convert lazily. Derived
  generations publish only after all writes and expire with their source lifetime.
  Verify cleanup and retry behavior as storage versions evolve. Single-message
  conversion and concurrent cold requests still need CPU/memory measurements;
  these changes do not establish an isolate-wide peak-memory guarantee.
- Verify logical expiry, bounded D1 cleanup, and asynchronous R2 lifecycle deletion.
- Back up R2 Terraform state privately; the state bucket must have no email-expiry policy.
- Use the verified R2 lockfile backend and serialize full deployment workflows per environment.
- Keep credentials out of logs, generated configuration, commits, and support output.
- Verify real SMTP delivery, including Bcc, multiple recipients, and private forwarding.

Private access is enabled by default. It is one instance-level token, not a
per-mailbox authorization system; possession of it allows access to every
non-reserved inbox on that instance.
