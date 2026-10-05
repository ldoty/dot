# Amber’s Finances at amber-finances.dot-y.co, for members of amber_finances: the finances tool
# (tools/finances) deployed for Amber, with her own SimpleFIN Bridge connection.

module "finances" {
  source           = "../../finances/infra"
  tool             = "amber-finances"
  group            = "amber_finances"
  title            = "Amber’s Finances"
  tile_description = "Amber’s accounts, filed under her budget: how each line is tracking this month."
  person           = "Amber"
  partition        = "AMBER"
  owner = {
    sub      = "74c8b418-e0b1-7075-7ae5-ca791980dd07"
    username = "74c8b418-e0b1-7075-7ae5-ca791980dd07"
  }
}

output "url" { value = module.finances.url }
output "api_url" { value = module.finances.api_url }
