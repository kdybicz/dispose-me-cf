variable "account_id" {
  type        = string
  description = "Cloudflare account containing the private state bucket."
}

variable "state_bucket_name" {
  type        = string
  description = "Dedicated state bucket created and imported by the bootstrap command."
}

resource "cloudflare_r2_bucket" "terraform_state" {
  account_id    = var.account_id
  name          = var.state_bucket_name
  storage_class = "Standard"
  lifecycle {
    prevent_destroy = true
  }
}

output "state_bucket" {
  value = cloudflare_r2_bucket.terraform_state.name
}
