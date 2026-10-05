# Luke’s Finances

`https://luke-finances.dot-y.co/` · permission group **`luke_finances`** (Luke) · table `family-luke-finances` (partition `LUKE`)

A deployment of the finances tool: the code, page, tests and infra module are in `tools/finances`
(see its README). This folder is the root that deploys it (`infra/`) and its live checks.

```sh
npm run build
cd tools/luke-finances/infra && tofu init && tofu apply
npm run test:live
```

SimpleFIN: paste the setup token over the placeholder in SSM `/family/luke-finances/simplefin`; the first sync
claims it and stores the access URL in its place.
