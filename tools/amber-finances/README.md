# Amber’s Finances

`https://amber-finances.dot-y.co/` · permission group **`amber_finances`** (Amber) · table `family-amber-finances` (partition `AMBER`)

A deployment of the finances tool: the code, page, tests and infra module are in `tools/finances`
(see its README). This folder is the root that deploys it (`infra/`) and its live checks.

```sh
npm run build
cd tools/amber-finances/infra && tofu init && tofu apply
npm run test:live
```

SimpleFIN: paste the setup token over the placeholder in SSM `/family/amber-finances/simplefin`; the first sync
claims it and stores the access URL in its place.
