variable "account_id" {
  description = "Cloudflare account containing the application resources."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "account_id must be a 32-character lowercase hexadecimal Cloudflare ID."
  }
}

variable "domain_name" {
  description = "Existing Cloudflare zone apex used for the inbox UI and incoming email."
  type        = string
  validation {
    condition     = length(var.domain_name) <= 253 && can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,}$", var.domain_name))
    error_message = "domain_name must be a lowercase domain name without a scheme, path, or wildcard."
  }
}

variable "resource_prefix" {
  description = "Distinct resource prefix for each deployed environment."
  type        = string
  default     = "dispose-me-cf"
  validation {
    condition     = length(var.resource_prefix) >= 3 && length(var.resource_prefix) <= 40 && can(regex("^[a-z][a-z0-9-]*[a-z0-9]$", var.resource_prefix))
    error_message = "resource_prefix must be 3-40 lowercase letters, digits, or hyphens and start/end with a letter or digit."
  }
}

variable "email_ttl_days" {
  description = "Shared logical D1 retention and physical R2 lifecycle retention."
  type        = number
  default     = 1
  validation {
    condition     = var.email_ttl_days >= 1 && floor(var.email_ttl_days) == var.email_ttl_days
    error_message = "email_ttl_days must be a positive whole number."
  }
}

variable "cookie_ttl_days" {
  type        = number
  description = "Lifetime of remembered login cookies."
  default     = 30
  validation {
    condition     = var.cookie_ttl_days >= 1 && floor(var.cookie_ttl_days) == var.cookie_ttl_days
    error_message = "cookie_ttl_days must be a positive whole number."
  }
}

variable "private_access" {
  description = "Require the Worker ACCESS_TOKEN secret for inbox access."
  type        = bool
  default     = true
}

variable "inbox_blacklist" {
  description = "Reserved local parts that cannot receive disposable email."
  type        = list(string)
  default     = ["hostmaster", "postmaster", "webmaster", "admin", "administrator", "abuse", "root", "ssl-admin", "majordomo"]
  validation {
    condition     = alltrue([for name in var.inbox_blacklist : can(regex("^[a-z0-9_-]{3,25}$", name))]) && length(distinct(var.inbox_blacklist)) == length(var.inbox_blacklist)
    error_message = "Reserved inboxes must be unique normalized lowercase local parts of 3-25 characters."
  }
}

variable "reserved_forward_to" {
  description = "Already verified private forwarding destination for reserved aliases; null rejects them."
  type        = string
  default     = null
  validation {
    condition     = var.reserved_forward_to == null ? true : can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.reserved_forward_to))
    error_message = "reserved_forward_to must be an email address or null."
  }
  validation {
    condition     = var.reserved_forward_to == null ? true : !endswith(lower(var.reserved_forward_to), "@${var.domain_name}")
    error_message = "Use a private destination outside the disposable email domain to avoid forwarding loops."
  }
}
