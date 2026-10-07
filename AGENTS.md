# Agent guide: dot-y.co

Read this before changing anything. It tells you how the project is put together, the rules it
keeps, and how to work in it without breaking the family's tools. `README.md` is the short human
overview; each tool's own `README.md` has its details.

## What this is

A handful of private family web tools on **dot-y.co**, behind one invite-only family login, all on
one AWS account. Each tool is a static page + a small Lambda API + its own DynamoDB table, deployed
with OpenTofu. The users are Luke and Amber (and invitees). The operator is Luke.

| Tool | Site | Group | What |
|---|---|---|---|
| `platform/core/portal` | dot-y.co | (any member) | Home page: a tile per tool you can use; also `/handoff`, `/sms`, `/privacy`, `/terms` |
| `tools/budget` | budget.dot-y.co | `family_budget` | Household budget: Shared + one per person, versions and tags |
| `tools/finances` | (code only) | | Finances code + infra module, deployed three times: |
| `tools/luke-finances` | luke-finances.dot-y.co | `luke_finances` | Luke’s bank accounts (SimpleFIN) filed under his budget |
| `tools/amber-finances` | amber-finances.dot-y.co | `amber_finances` | Amber’s, the same way |
| `tools/shared-finances` | shared-finances.dot-y.co | `shared_finances` | The joint accounts from both, against the Shared budget |
| `tools/assistant` | assistant.dot-y.co | `family_assistant` | **Dot**: chat with Claude (Bedrock) + calendars + any tool that describes itself |
| `tools/links` | links.dot-y.co | `family_links` | Family bookmarks |
| `tools/biomap` | biomap.dot-y.co | `lukes_biomap` | Field-guide flashcards from a private photo collection |
| `tools/tempi` | tempi.dot-y.co | `family_tempi` | An OT course, served to members only |
| `tools/boards` | boards.dot-y.co | `lukes_boards` | Field guide + flashcards for two nonprofit boards; the guide lives in gitignored `private/` |
| `tools/house-hunt` | house-hunt.dot-y.co | `family_house_hunt` | Neighborhoods on a map, ranked listings; listing emails to househunt@dot-y.co are filed by Claude |
| `tools/sms` | (API only) | | SMS opt-in consent records for the Dot-y texting program |
| `platform/email` | | | contact@dot-y.co: SES receive → S3 → forward to Gmail |
| `platform/billing` | | | Account-wide $75/mo budget + cost anomaly alerts |

AWS account `921782276410`, region `us-east-1`, CLI profile **`ldoty`**. State bucket
`family-tfstate-921782276410`, one key per root (`platform/<x>/…`, `tools/<x>/…`).

## How access works (keep all four checks)

1. **Cognito group gate** (`platform/core/lambda/pre-token.mjs`): every app client registers a rule
   at SSM `/family/apps/<clientId>`; no token is issued unless the user is in the tool's group. Fails closed.
2. **API Gateway JWT authorizer**: accepts only that tool's client id(s).
3. **The Lambda re-verifies** the token itself (`platform/api/verify-token.mjs`): signature, issuer,
   `token_use`, client id, expiry, group. Never trust the authorizer alone.
4. **IAM**: a tool's role reaches only its own table (and what it explicitly needs).

Sign-in: people sign in once at dot-y.co; a tool gets its *own* tokens through `/handoff`
(custom auth, `sso-auth.mjs`). Tokens never cross tools.

### Delegation: one tool reading another as a person

A tool can't read another tool's table. Instead it borrows a short-lived, **read-only** token *as a
person* from the other tool's **delegated client** (`platform/api/delegation.mjs`):

- The reader signs an assertion `{iss: <signer>, aud: <delegated client>, sub, username, exp ≤ 2 min}`
  with a KMS key only its role may use. Signers are `dot` (Dot's key) and the entries of
  `delegation_signers` in `platform/core/auth.tf` (each limited to the users it may act for).
- The target tool opts in with family-app `delegated = true` and lists who may read it in
  `delegates` (default `["dot"]`). It publishes `{api_url, client_id}` at SSM `/family/delegation/<group>`.
- Cognito still applies the group gate; tokens come out marked `via: "dot"`; **the target refuses
  every non-GET from them** (403 `read-only`). Reads are audited by the reader.

Current links: Dot → any tool with a manifest (today the three finances tools); finances tools → Budget (as their person);
Shared Finances → Luke’s and Amber’s finances (their `GET /shared/{from}`).

### Dot (the assistant) and tool discovery

Dot (`tools/assistant`; internals in `tools/assistant/AGENTS.md`) acts as whoever is signed in. Apart
from its built-ins (calendar, `read_budget`), **every tool is discovered** (`api/discovery.mjs`): Dot lists `/family/delegation/*`, borrows a token for the
asker, reads each tool's `GET /dot` manifest (`platform/api/dot-manifest.mjs`) and offers its
operations as `<name>_<operation>` tools, GET only. To make a tool usable by Dot: `delegated = true`,
publish `/family/delegation/<group>`, serve `GET /dot` (validate it with `validateManifest`), accept the
delegated client id in its token check, refuse non-GET from it. No Dot code change.

## Conventions

- **Code**: plain ES modules (`.mjs`), Node 22, no TypeScript, no frameworks. Pages are single
  `index.html` files with inline CSS/JS in the existing ES5-ish style (`var`, `function`), no build
  step. Match the surrounding style and comment density: comments say *why* and what a rule protects.
- **Dependencies**: AWS SDK v3 (present in the Lambda runtime). Lambdas that need other packages
  (Anthropic SDK) are bundled by `npm run build` (esbuild) into `api/dist/` (gitignored): assistant,
  biomap, finances. Others are zipped from source by `archive_file` with symlinked shared files.
- **Shared code** lives in `platform/api` / `platform/web` and is **symlinked** into a tool and
  bundled at deploy, never loaded across sites at runtime.
- **House style**: Daylight theme only (no dark mode; `platform/tests/daylight.test.mjs` enforces it),
  tokens from `family.css`, sentence case, curly quotes (’ “ ”) in UI text. Plain, short UI copy.
- **Tables**: single table per tool, `pk`/`sk` strings, sort-key prefixes per row type (each tool's
  README lists its rows). `deletion_protection_enabled` + `prevent_destroy` on every table.
  Concurrent edits use a `rev` and a conditional put (409 with the current value), as Budget and House Hunt do.
- **Commits**: subject `Tool: what changed` (e.g. `Finances: …`, `Budget + Finances: …`), a short body
  saying why, the repo's Co-Authored-By trailer. Luke commits straight to `main` and pushes.
- Ask before changing anything access-related (groups, delegates, signers, IAM). Never weaken a check.

## Tests

`npm test` needs no AWS; `npm run test:live` runs read-only checks against what's deployed (profile `ldoty`).
Only **top-level** `*.test.mjs` files in `platform/tests/` and `tools/*/tests/` run: a test in a subfolder (e.g. `tests/helpers/`)
or with another name is silently skipped.

- **API tests** call the real handler through `platform/tests/helpers/http.mjs` (`caller(handler, routes)`)
  with tokens from `helpers/tokens.mjs` (`accessToken`, `forgedToken`; a throwaway JWKS) against
  `helpers/fake-table.mjs`, an in-memory DynamoDB that **enforces** what the code relies on. It supports
  Get, Put (conditions `attribute_not_exists(pk)` and `rev = :rev`), Delete, Update (`SET a = :x, …`) and
  Query (`pk = :pk`, `begins_with(sk, :p)`). It throws on other Put conditions, Update expressions and
  Query key conditions, but **silently ignores** conditions on Delete/Update, Query `FilterExpression`,
  `Limit` and `ScanIndexForward`, and returns nothing for commands it doesn't mock (Scan, BatchWrite,
  Transact*). If your code uses any of those, extend the fake first, or your tests prove nothing.
- **Page tests** load the real `web/index.html` in jsdom with a stub `FamilyAuth` and a `fetch` routed
  to the real handler (see `tools/finances/tests/web.test.mjs`, `tools/links/tests/web.test.mjs`).
- Every change gets a test, and the test should fail without the change (break the code, watch it fail, restore).
- Keep the routes in `infra/api.tf` and the handler in step (Finances has a test that checks it; copy it for new tools).

## Deploying

```sh
npm run build                                   # first, if you touched assistant, biomap or finances
cd tools/<tool>/infra && tofu plan && tofu apply   # plan first; read it
cd platform/core && tofu apply                  # after adding/renaming a tool (home page tiles) or signers
npm run test:live
```

- **Read every plan.** Expect `0 to destroy`. Tables are protected, but stop and ask if a plan replaces
  anything stateful (tables, the user pool, buckets, KMS keys, the SimpleFIN secrets).
- Order for cross-tool changes: core (signers, rules) → the tool being read (delegates) → the reader.
- New tool: `platform/scripts/new-tool.sh <name> "Title" [group]`, then its infra, then core, then
  `invite.sh` or add people to the group (`aws cognito-idp admin-add-user-to-group`).
- Cognito usernames are the users' `sub`s: Luke `44f8c468-4011-70b8-76aa-ec2b68b0b004`,
  Amber `74c8b418-e0b1-7075-7ae5-ca791980dd07`.

## SSM parameters (the glue between roots)

| Name | What |
|---|---|
| `/family/core/user-pool-id`, `certificate-arn`, `auth-domain`, `home-client-id` | Core outputs every tool reads |
| `/family/core/delegation-key-arn`, `/family/core/signers/<name>` | Dot's and the other signers' KMS keys |
| `/family/apps/<clientId>` | Each app client's access rule: `{app, group, portal, returns}` (returns = hand-off URLs); a delegated client's is `{app, group, delegated, delegates}` |
| `/family/catalog/<group>` | Home page tile |
| `/family/delegation/<group>` | `{api_url, client_id}` of a tool that can be read as a person |
| `/family/<tool>/simplefin` | SecureString: a finances tool's SimpleFIN setup token or access URL |
| `/family/calendar/google-key` | SecureString: Dot's Google service-account key |
| `/family/sms/optin-url` | The SMS opt-in endpoint, for the public page |

## Tool notes

Per-tool notes load when you work in that tool: `tools/budget/AGENTS.md` (docs, versions, tags, plans),
`tools/finances/AGENTS.md` (deployments, sync, line ids, filing precedence), `tools/assistant/AGENTS.md` (Dot).
Read them first when a change crosses into one of those tools (e.g. Dot or Finances reading Budget).

- **Finances: never change the description of the `simplefin` SSM parameter**: rewriting a SecureString can
  replace its value (the live access URL). The module keeps it byte-for-byte.

### Others
- **House Hunt**: `rev`-checked writes; SES → bucket → ingest Lambda (`api/ingest.mjs`, bundled by `npm run build`) that accepts
  allowed senders with DMARC passing and has Claude extract listings as untrusted data into a fixed schema.
- **Links**: sections + http(s)-only links. **Tempi**: the course HTML is in the Lambda, served only to
  members. **Biomap**: `collection/` is gitignored; `scripts/publish.sh` builds the deck and syncs photos
  to a private bucket. **SMS**: consent text in `api/program.mjs` must match `portal/sms.html` (tested);
  the Lambda can only write the consent table. **Email**: SES inbound, forwarded with Reply-To.

## Working here: things that bite

- **Other sessions may be working in the same checkout.** Check `git status` first; commit only the
  files you changed (`git add <paths>`), never `git add -A` blindly.
- The shell is **zsh**: unquoted `$VAR` doesn't word-split (`set -- $X` won't), there's no `timeout`.
- AWS credentials for profile `ldoty` expire; on `ExpiredTokenException`, ask Luke to refresh them
  (he can run the command in the session with `!`).
- `tofu` may need `tofu init` in a root you haven't used; `.terraform/`, `.build/`, `*.tfplan`, `dist/` are ignored.
- Bedrock: Opus 4.6 is enabled; newer models return “not available for this account” until AWS approves them.
- SimpleFIN Bridge is rate-limited (the API spaces manual syncs 5 minutes apart) and serves at most
  90 days per request (89 + the end date); SimpleFIN itself warns (in the sync's errors) past 45. Some banks (Marcus) need re-authorizing at
  bridge.simplefin.org often: the sync reports it; nothing to fix in code.
- Headless Chrome has a ~500px minimum window: to see phone width, render the page in a 390px iframe.
- Every site file is served with `max-age=60`; after a deploy, reload (or wait a minute).
- `private/` is gitignored real household data: never commit it, never copy it into tracked files.
- Real data stays out of git: seeds read from `private/`, fixtures in tests are invented.
