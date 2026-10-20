output "url" {
  description = "Application URL after the custom domain and TLS are ready."
  value       = "https://${cloudflare_workers_custom_domain.inbox.hostname}"
}
