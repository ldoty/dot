# SDC/SCE Finances at sdc-sce-finances.dot-y.co, for members of sdc_sce_finances (Luke, Amber and Lindsay):
# the finances tool (tools/finances) for the business's own SimpleFIN connection, filed under the
# SDC/SCE Budget (tools/sdc-sce-budget) instead of the household's. No joint accounts (there's no
# household to share them with), and nothing else may read it: not Dot, not Claude Code.

module "finances" {
  source           = "../../finances/infra"
  tool             = "sdc-sce-finances"
  group            = "sdc_sce_finances"
  title            = "SDC/SCE Finances"
  tile_description = "The business’s accounts, filed under the SDC/SCE budget: how each line is tracking this month."
  person           = "Business" # the SDC/SCE Budget's one doc
  partition        = "SDC_SCE"
  budget_app       = "sdc_sce_budget"
  joint_accounts   = false
  delegates        = [] # no delegated client, nothing at /family/delegation/sdc_sce_finances
  # Whose access reads the budget on the nightly sync (core's delegation_signers lets this tool act
  # for Luke, Amber and Lindsay, so "Refresh budget" works for each)
  owner = {
    sub      = "44f8c468-4011-70b8-76aa-ec2b68b0b004"
    username = "44f8c468-4011-70b8-76aa-ec2b68b0b004"
  }
}

output "url" { value = module.finances.url }
output "api_url" { value = module.finances.api_url }
