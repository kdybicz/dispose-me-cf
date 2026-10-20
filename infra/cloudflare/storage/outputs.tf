output "deployment" {
  description = "Non-secret input for Wrangler and the routing Terraform configuration."
  value = {
    account_id          = var.account_id
    zone_id             = data.cloudflare_zone.domain.id
    domain_name         = data.cloudflare_zone.domain.name
    worker_name         = "${var.resource_prefix}-worker"
    database_id         = cloudflare_d1_database.inbox.id
    database_name       = cloudflare_d1_database.inbox.name
    bucket_name         = cloudflare_r2_bucket.emails.name
    email_ttl_days      = var.email_ttl_days
    cookie_ttl_days     = var.cookie_ttl_days
    private_access      = var.private_access
    inbox_blacklist     = join(",", var.inbox_blacklist)
    reserved_forward_to = var.reserved_forward_to
  }

  # The zone lookup must resolve the exact apex in the selected account.
  precondition {
    condition     = data.cloudflare_zone.domain.name == var.domain_name && data.cloudflare_zone.domain.account.id == var.account_id
    error_message = "The selected zone does not match domain_name/account_id."
  }

  depends_on = [cloudflare_r2_bucket_lifecycle.emails]
}
