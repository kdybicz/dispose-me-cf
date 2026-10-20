data "cloudflare_zone" "domain" {
  zone_id = var.deployment.zone_id
}

resource "cloudflare_zone_setting" "https_redirect" {
  zone_id    = var.deployment.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.deployment.zone_id
  name    = "_dmarc.${var.deployment.domain_name}"
  type    = "TXT"
  content = "\"v=DMARC1; p=reject; sp=reject;\""
  ttl     = 1
  proxied = false
}

# Creating this binding also creates the managed HTTP DNS record and TLS certificate.
# Cloudflare requires the Worker service to exist before this resource can be created.
resource "cloudflare_workers_custom_domain" "inbox" {
  account_id = var.deployment.account_id
  zone_id    = var.deployment.zone_id
  hostname   = var.deployment.domain_name
  service    = var.deployment.worker_name

  lifecycle {
    precondition {
      condition     = data.cloudflare_zone.domain.name == var.deployment.domain_name && data.cloudflare_zone.domain.account.id == var.deployment.account_id && data.cloudflare_zone.domain.status == "active"
      error_message = "Routing requires the matching active Cloudflare zone in the selected account."
    }
  }
}

resource "cloudflare_ruleset" "www_redirect" {
  zone_id = var.deployment.zone_id
  name    = "Dispose Me - Cloudflare redirects"
  kind    = "zone"
  phase   = "http_request_dynamic_redirect"

  rules = [{
    ref         = "www_to_apex"
    description = "Redirect www to the canonical HTTPS domain"
    expression  = "http.host eq \"www.${var.deployment.domain_name}\""
    action      = "redirect"
    enabled     = true
    action_parameters = {
      from_value = {
        status_code           = 301
        preserve_query_string = true
        target_url = {
          expression = "concat(\"https://${cloudflare_workers_custom_domain.inbox.hostname}\", http.request.uri.path)"
        }
      }
    }
  }]
}

resource "cloudflare_dns_record" "www" {
  zone_id = var.deployment.zone_id
  name    = "www.${var.deployment.domain_name}"
  type    = "CNAME"
  content = cloudflare_workers_custom_domain.inbox.hostname
  proxied = true
  ttl     = 1

  depends_on = [cloudflare_ruleset.www_redirect]
}

# Cloudflare adds and locks its required MX/SPF records through this resource.
# Do not manage the same records separately with cloudflare_dns_record or Wrangler.
resource "cloudflare_email_routing_dns" "inbox" {
  zone_id = var.deployment.zone_id

  # Omit name for the zone apex. Setting it causes this provider to send a
  # PATCH interpreted as a subdomain update when adopting existing routing.

  depends_on = [cloudflare_workers_custom_domain.inbox]
}

resource "cloudflare_email_routing_catch_all" "inbox" {
  zone_id  = var.deployment.zone_id
  name     = "Dispose Me - Cloudflare catch-all"
  enabled  = true
  matchers = [{ type = "all" }]
  actions = [{
    type  = "worker"
    value = [cloudflare_workers_custom_domain.inbox.service]
  }]

  depends_on = [cloudflare_email_routing_dns.inbox]
}

# Literal reserved addresses are forwarded before the disposable catch-all.
# Their normalized variants remain blocked by the Worker and never enter storage.
resource "cloudflare_email_routing_rule" "reserved" {
  for_each = var.deployment.reserved_forward_to == null ? toset([]) : toset(compact(split(",", var.deployment.inbox_blacklist)))

  zone_id  = var.deployment.zone_id
  name     = "Private forwarding for ${each.key}"
  enabled  = true
  priority = 0
  matchers = [{
    type  = "literal"
    field = "to"
    value = "${each.key}@${var.deployment.domain_name}"
  }]
  actions = [{
    type  = "forward"
    value = [var.deployment.reserved_forward_to]
  }]

  depends_on = [cloudflare_email_routing_dns.inbox]
}
