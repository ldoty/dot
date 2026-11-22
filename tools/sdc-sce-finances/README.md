# SDC/SCE Finances

`https://sdc-sce-finances.dot-y.co/` · permission group **`sdc_sce_finances`** (Luke, Amber and Lindsay) · table `family-sdc-sce-finances` (partition `SDC_SCE`)

A deployment of the finances tool (code, page, tests and infra module in `tools/finances`) for the
business: its own SimpleFIN connection, filed under the **SDC/SCE Budget** (`tools/sdc-sce-budget`,
doc `Business`, read as the person with this tool's signer `sdc_sce_finances`) instead of the
household Budget. `joint_accounts = false`: no account can be marked shared and there's no
`GET /shared` feed. `delegates = []`: no delegated client, so Dot and Claude Code can't read it.

```sh
npm run build
cd tools/sdc-sce-finances/infra && tofu init && tofu apply
npm run test:live
```

SimpleFIN: paste the setup token over the placeholder in SSM `/family/sdc-sce-finances/simplefin`; the first sync
claims it and stores the access URL in its place.
