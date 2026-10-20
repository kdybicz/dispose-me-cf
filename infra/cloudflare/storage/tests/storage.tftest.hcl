mock_provider "cloudflare" {
  override_during = plan
  mock_data "cloudflare_zone" {
    defaults = {
      id      = "abcdef0123456789abcdef0123456789"
      name    = "app.example.net"
      account = { id = "0123456789abcdef0123456789abcdef", name = "Test account" }
    }
  }

  mock_resource "cloudflare_d1_database" {
    defaults = { id = "11111111-2222-3333-4444-555555555555" }
  }
}

variables {
  account_id  = "0123456789abcdef0123456789abcdef"
  domain_name = "app.example.net"
}

run "retention_and_deployment_contract" {
  command = plan
  variables { email_ttl_days = 3 }

  assert {
    condition     = cloudflare_r2_bucket_lifecycle.emails.rules[0].delete_objects_transition.condition.max_age == 259200 && output.deployment.email_ttl_days == 3
    error_message = "R2 lifecycle and application expiration must use the same retention period."
  }
  assert {
    condition     = output.deployment.database_id == "11111111-2222-3333-4444-555555555555" && output.deployment.bucket_name == cloudflare_r2_bucket.emails.name && output.deployment.zone_id == data.cloudflare_zone.domain.id
    error_message = "Deployment configuration must use provisioned resources and the resolved zone."
  }
}

run "invalid_retention" {
  command = plan
  variables { email_ttl_days = 0 }
  expect_failures = [var.email_ttl_days]
}

run "wrong_zone_account" {
  command = plan
  override_data {
    target = data.cloudflare_zone.domain
    values = {
      name    = "app.example.net"
      account = { id = "ffffffffffffffffffffffffffffffff", name = "Other account" }
    }
  }
  expect_failures = [output.deployment]
}
