# home_host

Family tools on **dot-y.co**, behind one family login. AWS account `921782276410`, profile `ldoty`, `us-east-1`.
Infrastructure is OpenTofu; state lives in `s3://family-tfstate-921782276410` (one key per root).

```
platform/                 what every tool builds on
  bootstrap/              the state bucket
  billing/                account-wide spending alerts: $75/mo budget + cost anomaly detection
  core/                   domain cert, Cognito pool + auth.dot-y.co, sign-in gate Lambda, home page infra
    portal/               the dot-y.co home page
  web/                    shared frontend: family-auth.js, family.css, favicon, style-guide.html
  api/                    shared Lambda code: verify-token.mjs
  modules/                family-app (client, groups, access rule, tile), static-site
  templates/tool/         what new-tool.sh copies
  scripts/                invite.sh, new-tool.sh
  tests/                  platform tests + shared test helpers
tools/
  budget/                 budget.dot-y.co (see its README)
  links/                  links.dot-y.co: family bookmarks by section
  assistant/              assistant.dot-y.co: Luke's chat with Claude (Bedrock) + calendar tools
private/                  local only, gitignored (e.g. project_pax)
```

Each tool is self-contained: `web/`, `api/`, `infra/` (its own state), `scripts/`, `tests/`.
Shared files are copied into each tool at deploy, never loaded across sites.

## How access works

One Cognito pool; each tool has its own app client and a permission group (`family_<tool>`, plus `:admin`).
The sign-in gate refuses tokens for a tool unless the user is in its group, API Gateway only accepts
that tool's tokens, each Lambda re-verifies the token itself, and each tool's IAM role only reaches its own table.
The home page is the one "portal" client that sees all groups, to show each person their tool tiles.

## Common tasks

```sh
npm install && npm test                 # all unit + page tests (no AWS)
npm run build                           # bundles Lambdas that need npm packages (the assistant)
npm run test:live                       # read-only checks against what's deployed
platform/scripts/new-tool.sh recipes "Recipes"
platform/scripts/invite.sh someone@example.com Name family_budget
cd <root> && tofu plan / tofu apply     # platform/core, tools/<tool>/infra
```

After adding or renaming a tool, re-apply `platform/core` so the home page tile list updates.
