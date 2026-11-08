# Worker log redaction

The application supports `x-api-key` query authentication, including image URLs in
the opaque-origin email viewer. Those query values must not appear in persisted
Cloudflare invocation logs or traces.

## Configuration and deployment

`wrangler.jsonc` enables the supported top-level observability setting:

```json
{
  "observability": {
    "enabled": true,
    "redact_query_string": true
  }
}
```

Wrangler 4.148.0 supports this setting. The deployment helper copies observability
settings into the ignored `wrangler.deploy.json`, so regenerating configuration or
redeploying preserves redaction. Apply the change through the normal Worker
deployment workflow. Terraform does not own these settings.

This removes the entire query string from platform-recorded request URLs while
retaining useful invocation details such as method, path, status, and timing.
It does not modify incoming requests or disable query authentication. Application
debug/error response logs separately omit `x-api-key` query values and do not log
authentication headers or cookies. Platform redaction is not a sanitizer for
arbitrary strings passed to the application Logger.

## Verification

1. Run `make test`. Deployment tests check the real base configuration and generated
   production configuration; application tests exercise debug/error response logs
   with synthetic query, header, authorization, and cookie credentials.
2. After deployment, read
   `GET /accounts/{account_id}/workers/scripts/{worker_name}/settings` with a
   Cloudflare API token supplied through the environment. Confirm
   `result.observability.redact_query_string` is `true` and invocation logging and
   persistence remain enabled. Repeat after a normal redeployment.
3. Generate a unique synthetic marker, such as `log-redaction-<random UUID>`, and
   request `https://<domain>/<marker>?x-api-key=<synthetic alphanumeric value>&type=json`.
   Use an intentionally invalid synthetic credential; a private instance should
   return 403. Do not use a real application token or a real mailbox/message path.
4. In persisted Workers Logs, filter to that Worker and the marker **in the path**
   over the bounded verification interval. Confirm the invocation event is present,
   but neither the synthetic credential nor any query string appears in its request
   URL, invocation message, or other persisted event fields. An empty result is
   inconclusive, not a passing check: wait for ingestion with a deadline or report
   the verification as pending.
5. If using the telemetry API, run an ad-hoc query with `dry: true`, an explicit
   timeframe, and Worker/path filters. Never dump unrelated log entries or search
   using live credentials. Access to the telemetry query API requires the
   Cloudflare **Workers Observability Write** permission even for read queries.

Enabling redaction affects newly recorded events; it does not retroactively scrub
older persisted logs. No live credentials or message data should be copied into
issues, verification output, or support artifacts.
