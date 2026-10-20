mock_provider "cloudflare" {
  override_during = plan
  mock_data "cloudflare_zone" {
    defaults = {
      name    = "app.example.net"
      status  = "active"
      account = { id = "0123456789abcdef0123456789abcdef", name = "Test account" }
    }
  }
}

variables {
  deployment = {
    account_id  = "0123456789abcdef0123456789abcdef"
    zone_id     = "abcdef0123456789abcdef0123456789"
    domain_name = "app.example.net"
    worker_name = "dispose-me-cf-worker"
  }
}

run "catch_all_and_domain_use_the_deployed_worker" {
  command = plan
  assert {
    condition     = cloudflare_zone_setting.https_redirect.setting_id == "always_use_https" && cloudflare_zone_setting.https_redirect.value == "on"
    error_message = "HTTP navigation must redirect to HTTPS before serving the application."
  }
  assert {
    condition     = cloudflare_email_routing_catch_all.inbox.actions[0].type == "worker" && cloudflare_email_routing_catch_all.inbox.actions[0].value[0] == var.deployment.worker_name && cloudflare_email_routing_catch_all.inbox.matchers[0].type == "all"
    error_message = "Catch-all mail must go to the deployed Worker rather than an external mailbox."
  }
  assert {
    condition     = cloudflare_workers_custom_domain.inbox.hostname == var.deployment.domain_name && cloudflare_email_routing_dns.inbox.zone_id == var.deployment.zone_id
    error_message = "The web application and inbound MX/SPF configuration must use the same domain."
  }
  assert {
    condition     = cloudflare_email_routing_dns.inbox.name == null
    error_message = "Apex Email Routing must omit name to avoid an invalid subdomain PATCH on refresh/import."
  }
  assert {
    condition     = length(cloudflare_email_routing_rule.reserved) == 0
    error_message = "A deployment without a forwarding destination must not forward reserved mail."
  }
}

run "reject_dmarc_covers_zone_and_subdomains" {
  command = plan
  assert {
    condition     = cloudflare_dns_record.dmarc.zone_id == var.deployment.zone_id && cloudflare_dns_record.dmarc.name == "_dmarc.${var.deployment.domain_name}" && cloudflare_dns_record.dmarc.type == "TXT" && cloudflare_dns_record.dmarc.content == "\"v=DMARC1; p=reject; sp=reject;\"" && !cloudflare_dns_record.dmarc.proxied
    error_message = "The configured domain must publish a DNS-only reject policy for itself and subdomains."
  }
}

run "www_redirect_is_scoped_and_preserves_url_components" {
  command = plan
  assert {
    condition     = cloudflare_dns_record.www.name == "www.${var.deployment.domain_name}" && cloudflare_dns_record.www.type == "CNAME" && cloudflare_dns_record.www.content == var.deployment.domain_name && cloudflare_dns_record.www.proxied
    error_message = "The www hostname must have a proxied CNAME to the canonical domain."
  }
  assert {
    condition     = cloudflare_ruleset.www_redirect.kind == "zone" && cloudflare_ruleset.www_redirect.phase == "http_request_dynamic_redirect" && length(cloudflare_ruleset.www_redirect.rules) == 1 && cloudflare_ruleset.www_redirect.rules[0].expression == "http.host eq \"www.${var.deployment.domain_name}\"" && cloudflare_ruleset.www_redirect.rules[0].enabled
    error_message = "The canonical redirect must match only the www hostname, not the application hostname."
  }
  assert {
    condition     = cloudflare_ruleset.www_redirect.rules[0].action_parameters.from_value.status_code == 301 && cloudflare_ruleset.www_redirect.rules[0].action_parameters.from_value.preserve_query_string && cloudflare_ruleset.www_redirect.rules[0].action_parameters.from_value.target_url.expression == "concat(\"https://${var.deployment.domain_name}\", http.request.uri.path)"
    error_message = "The permanent redirect must preserve the path and query string and always target HTTPS."
  }
}

run "reserved_forwarding_covers_every_configured_alias" {
  command = plan
  variables {
    deployment = {
      account_id          = "0123456789abcdef0123456789abcdef"
      zone_id             = "abcdef0123456789abcdef0123456789"
      domain_name         = "app.example.net"
      worker_name         = "dispose-me-cf-worker"
      inbox_blacklist     = "hostmaster,postmaster,webmaster,admin,administrator,abuse,root,ssl-admin,majordomo"
      reserved_forward_to = "owner@example.org"
    }
  }
  assert {
    condition     = length(cloudflare_email_routing_rule.reserved) == 9 && alltrue([for name, rule in cloudflare_email_routing_rule.reserved : rule.enabled && rule.priority == 0 && rule.matchers[0].value == "${name}@app.example.net" && rule.actions[0].type == "forward" && rule.actions[0].value[0] == "owner@example.org"])
    error_message = "Every reserved alias must bypass disposable storage and forward to the verified private mailbox."
  }
}

run "inactive_zone" {
  command = plan
  override_data {
    target = data.cloudflare_zone.domain
    values = {
      name    = "app.example.net"
      status  = "pending"
      account = { id = "0123456789abcdef0123456789abcdef", name = "Test account" }
    }
  }
  expect_failures = [cloudflare_workers_custom_domain.inbox]
}

run "wrong_zone_account" {
  command = plan
  override_data {
    target = data.cloudflare_zone.domain
    values = {
      name    = "app.example.net"
      status  = "active"
      account = { id = "ffffffffffffffffffffffffffffffff", name = "Other account" }
    }
  }
  expect_failures = [cloudflare_workers_custom_domain.inbox]
}
