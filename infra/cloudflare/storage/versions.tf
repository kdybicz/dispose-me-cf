terraform {
  required_version = ">= 1.13.0, < 2.0.0"

  backend "s3" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
  }
}

# Authentication comes from CLOUDFLARE_API_TOKEN, not Terraform inputs/state.
provider "cloudflare" {}
