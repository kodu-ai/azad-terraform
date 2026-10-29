variable "application" {
  description = "The Clerk application the setup created (`id` app_…). With delete_on_destroy, destroy deletes it and every user account in it; use only for installations whose data is deleted too."
  type = object({
    id                = string
    delete_on_destroy = bool
  })
  validation {
    condition     = can(regex("^app_[A-Za-z0-9]+$", var.application.id))
    error_message = "Use the Clerk application id (app_…)."
  }
}
