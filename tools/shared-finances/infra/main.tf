# Shared Finances at shared-finances.dot-y.co, for members of shared_finances (Luke and Amber): the
# finances tool (tools/finances) in household mode. Its accounts are the ones marked shared in
# Luke's and Amber's finances, read from each as its owner (read-only) and de-duplicated, filed
# under the Shared budget.

module "finances" {
  source           = "../../finances/infra"
  tool             = "shared-finances"
  group            = "shared_finances"
  title            = "Shared Finances"
  tile_description = "The household’s joint accounts, filed under the Shared budget: how each line is tracking this month."
  mode             = "shared"
  partition        = "SHARED"
  delegates        = ["dot"]
  schedule         = "cron(0 7 * * ? *)" # after both personal tools (6:30)
  # Whose access reads the Shared budget on the nightly sync
  owner = {
    sub      = "44f8c468-4011-70b8-76aa-ec2b68b0b004"
    username = "44f8c468-4011-70b8-76aa-ec2b68b0b004"
  }
  sources = [
    { app = "luke_finances", name = "Luke", sub = "44f8c468-4011-70b8-76aa-ec2b68b0b004", username = "44f8c468-4011-70b8-76aa-ec2b68b0b004" },
    { app = "amber_finances", name = "Amber", sub = "74c8b418-e0b1-7075-7ae5-ca791980dd07", username = "74c8b418-e0b1-7075-7ae5-ca791980dd07" },
  ]
}

output "url" { value = module.finances.url }
output "api_url" { value = module.finances.api_url }
