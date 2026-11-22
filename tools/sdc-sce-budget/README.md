# SDC/SCE Budget

`https://sdc-sce-budget.dot-y.co/` · permission group **`sdc_sce_budget`** (Luke, Amber and Lindsay) · table `family-sdc-sce-budget` (partition `BUSINESS#sdc-sce`)

The business's budget: income, expense categories and categories set aside (taxes, a reserve), each
item per month or per year. It works like the household Budget (`tools/budget`) without the household
parts (no split, mortgage, Shared contributions or planning): one doc, `Business`, with a working copy
that saves itself (`DOC#Business#STATE`, `rev`-checked: a stale save gets 409 and the page loads the
other person's copy), saved versions (`DOC#Business#VERSION#<id>`) and tags (`TAG#Business#<name>`;
`default` opens on load, can't be deleted, and a tagged version can't be deleted).

The API has the same shapes as Budget's (`GET /all` → `{docs, versions, tags}`), so **SDC/SCE Finances**
(`tools/sdc-sce-finances`) reads it with the finances code unchanged (`resolveLines` with person
`Business`; tested in `tests/api.test.mjs`). It's the only reader: the delegated client's `delegates` is
`["sdc_sce_finances"]`, and its tokens are read-only. Dot and Claude Code can't read it.

```sh
cd tools/sdc-sce-budget/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply   # the home page tile
npm run test:live
```
