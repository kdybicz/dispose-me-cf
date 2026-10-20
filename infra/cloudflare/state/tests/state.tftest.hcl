mock_provider "cloudflare" {
  override_during = plan
}

variables {
  account_id        = "0123456789abcdef0123456789abcdef"
  state_bucket_name = "dispose-me-cf-terraform-state"
}

run "dedicated_standard_state_bucket" {
  command = plan
  assert {
    condition     = cloudflare_r2_bucket.terraform_state.name == var.state_bucket_name && cloudflare_r2_bucket.terraform_state.storage_class == "Standard"
    error_message = "State must be kept in its own Standard bucket, outside email lifecycle rules."
  }
}
