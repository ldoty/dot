# Spending alerts for the whole AWS account (921782276410), not just the family site.
# AWS has no hard spending cap, and this is the Organization's management account (SCPs
# don't apply to it), so these alert rather than block.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {
    bucket       = "family-tfstate-921782276410"
    key          = "platform/billing/terraform.tfstate"
    region       = "us-east-1"
    profile      = "ldoty"
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "ldoty"
  default_tags { tags = { project = "family", root = "billing" } }
}

variable "alert_email" {
  type    = string
  default = "luke.doty@gmail.com"
}

variable "monthly_limit_usd" {
  type        = number
  default     = 75
  description = "Baseline was ~$34/mo in mid-2026; domain renewals add $15-54 in some months."
}

variable "anomaly_threshold_usd" {
  type    = number
  default = 10
}

# Emails at 80% and 100% of actual spend, and when the month is forecast to go over
resource "aws_budgets_budget" "monthly" {
  name         = "monthly-total"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [
      { type = "ACTUAL", pct = 80 },
      { type = "ACTUAL", pct = 100 },
      { type = "FORECASTED", pct = 100 },
    ]
    content {
      comparison_operator        = "GREATER_THAN"
      notification_type          = notification.value.type
      threshold                  = notification.value.pct
      threshold_type             = "PERCENTAGE"
      subscriber_email_addresses = [var.alert_email]
    }
  }
}

# Flags any service suddenly costing more than its usual pattern, before the budget would notice
resource "aws_ce_anomaly_monitor" "services" {
  name              = "by-service"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "email" {
  name             = "anomalies-over-${var.anomaly_threshold_usd}-usd"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  subscriber {
    type    = "EMAIL"
    address = var.alert_email
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_threshold_usd)]
    }
  }
}

output "budget" { value = format("%s: $%d/month, alerts at 80%% / 100%% / forecast 100%% to %s", aws_budgets_budget.monthly.name, var.monthly_limit_usd, var.alert_email) }
