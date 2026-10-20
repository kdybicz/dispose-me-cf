variable "deployment" {
  description = "Generated from the storage Terraform output; do not enter resource IDs manually."
  type = object({
    account_id          = string
    zone_id             = string
    domain_name         = string
    worker_name         = string
    inbox_blacklist     = optional(string, "")
    reserved_forward_to = optional(string)
  })
}
