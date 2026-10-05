# Shared Finances

`https://shared-finances.dot-y.co/` · permission group **`shared_finances`** (Luke & Amber) · table `family-shared-finances` (partition `SHARED`)

A deployment of the finances tool: the code, page, tests and infra module are in `tools/finances`
(see its README). This folder is the root that deploys it (`infra/`) and its live checks.

```sh
npm run build
cd tools/shared-finances/infra && tofu init && tofu apply
npm run test:live
```
