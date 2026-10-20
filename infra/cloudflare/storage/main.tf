data "cloudflare_zone" "domain" {
  filter = {
    name    = var.domain_name
    account = { id = var.account_id }
  }
}

resource "cloudflare_d1_database" "inbox" {
  account_id = var.account_id
  name       = "${var.resource_prefix}-inbox"

  # Match the API default; the provider otherwise attempts to update it to null.
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_r2_bucket" "emails" {
  account_id    = var.account_id
  name          = "${var.resource_prefix}-emails"
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket_lifecycle" "emails" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.emails.name
  rules = [{
    id         = "email-retention"
    enabled    = true
    conditions = { prefix = "" }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = var.email_ttl_days * 86400
      }
    }
  }]
}
