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
| `tools/calendars` | calendars.dot-y.co | `family_calendars` | The family's Google calendars and who may see or change each; the week ahead. The only holder of the Google key: Dot's calendar tools call it as the person. Notes in `tools/calendars/AGENTS.md` |
| `tools/lists` | lists.dot-y.co | `family_lists` | To-dos and checklists (checklist, Eisenhower matrix, board), private until shared with people or family groups; reminders by text or email from an every-minute sweep. Notes in `tools/lists/AGENTS.md` |
| `tools/links` | links.dot-y.co | `family_links` | Bookmarks in sections, private until shared with people or family groups (as Lists; `platform/api/sharing.mjs`) |
| `tools/health` | health.dot-y.co | `family_health` | Each person’s own workouts and how they feel: saved workouts, a plan, sessions logged set by set (last time’s numbers, rest timer, works offline; holds counted in breaths), body weight, how sore spots felt, a daily journal, a food log, medications and supplements with each day's doses, a meditation timer and log; a starter program. Dot reads it and logs sessions, food (from a photo), journal notes, meditations and doses as the person, and adds or (with their OK) changes supplements |
| `tools/biomap` | biomap.dot-y.co | `lukes_biomap` | Field-guide flashcards from a private photo collection |
| `tools/tempi` | tempi.dot-y.co | `family_tempi` | An OT course, served to members only |
| `tools/boards` | boards.dot-y.co | `lukes_boards` | Field guide + flashcards for two nonprofit boards; the guide lives in gitignored `private/` |
| `tools/cheer-research` | cheer-research.dot-y.co | `lukes_research` | Market research for a youth activities SaaS (cheer and dance first): guide, players, money flows + calculator, flashcards; the guide lives in gitignored `private/` |
| `tools/house-hunt` | house-hunt.dot-y.co | `family_house_hunt` | Neighborhoods on a map, ranked listings; listing emails to househunt@dot-y.co are filed by Claude |
| `tools/chamber` | chamber.dot-y.co | `lukes_chamber` | Mushroom chamber: Arduino firmware + build notes; the board posts telemetry to `POST /ingest` (device key), the page shows it and sets the board’s settings |
| `tools/house` | house.dot-y.co | `family_house` | Home Assistant by room, per-person grants; a relay at home dials out (WebSocket, device key) and reports only what `relay/ceiling.json` exposes; automations (made through Dot) run on the relay. Notes in `tools/house/AGENTS.md` |
| `tools/sms` | (API only) | | Dot-y texting program: opt-in consent records, and Twilio’s webhook that hands members’ texts to Dot |
| `platform/email` | | | contact@dot-y.co: SES receive → S3 → forward to Gmail; dot@dot-y.co: the gate that hands members’ mail to Dot |
| `platform/billing` | | | Account-wide $75/mo budget + cost anomaly alerts |
| `platform/family` | dot-y.co/family | `family_admin` | The family's groups and display names, shared by every tool (table `family-people`); tools read them with `platform/api/people.mjs` |

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
  every non-GET from them** (403 `read-only`) except the writes its manifest declares (`method` on an operation;
  `writeRoutes()` in `platform/api/dot-manifest.mjs` gives the tool its own allowlist from the same manifest). A declared
  write that needs the person's OK answers 202 `{ confirm_id, prompt }`, and Dot sends the confirmation only after their own
  reply. Declared today: House's automations (create, change, delete; each asks first), and Health's logging a session, a body weight, food or a dose, adding to the journal, a meditation or a supplement (additions only, so no asking), and changing a supplement (asks first; never a medication). Built into Dot instead: House's
  `POST /commands` (Dot's `house_control`), editing lists the person can edit (Dot's `lists_change`), never sharing, and events on calendars they may change (Dot's calendar tools). Reads are audited by the reader.

Current links: Dot → any tool with a manifest (today the three finances tools, House, Lists and Health); finances tools → Budget (as their person);
Shared Finances → Luke’s and Amber’s finances (their `GET /shared/{from}`).

### Dot (the assistant) and tool discovery

Dot (`tools/assistant`; internals in `tools/assistant/AGENTS.md`) acts as whoever is signed in. Apart
from its built-ins (calendar tools, through `tools/calendars`; `read_budget`, `house_control`, `lists_change`, memory), **every tool is discovered** (`api/discovery.mjs`): Dot lists `/family/delegation/*`, borrows a token for the
asker, reads each tool's `GET /dot` manifest (`platform/api/dot-manifest.mjs`) and offers its
operations as `<name>_<operation>` tools: reads, and the writes the tool declares (always through the confirmation
protocol above; never in a scheduled ask's read-only run). Dot **remembers** what people tell it that's likely to come up again (`api/memory.mjs`: household and
personal notes, shown on its page under “What Dot knows”), and runs **scheduled asks** (`api/schedules.mjs`:
“a budget overview every Sunday at 1”) as the person, read-only, sending the answer by text or email.

**Automations** are everything that runs on its own, of three kinds, each run where it must: House's (on the relay
at home), Dot's scheduled asks (in AWS) and Lists' reminders (Lists' sweep). They work alike: days are the same
RRULE subset (`tools/lists/api/repeat.mjs`, shared), each describes itself in one shape (`automationItem` in
`platform/api/dot-manifest.mjs`: says, on/paused/stopped and why, last run, next run), and from Dot every change
to a House automation or a scheduled ask needs the person's own reply. A tool joins by giving a manifest operation
`role: 'automations'`; Dot lists them all together (its `automations` tool, and “Runs on its own” on its page).
What a tool texted or emailed someone is its `role: 'sent'` operation: a text or email to Dot starts with a note of
what Dot-y sent them since they last wrote, so a reply to one makes sense. Everything sent unasked counts toward
one limit, **50 a person a day** across all tools (`platform/api/send-limit.mjs`, counted before sending; a new
sender must use it too), on top of each tool's own limits.

Members can also **text** Dot: the SMS webhook maps a
verified Cognito `phone_number` in `family_assistant` to the person, and Dot's SMS worker runs the same turn
(`tools/sms/README.md`, `tools/assistant/README.md`). They can **email** dot@dot-y.co the same way: the gate in
`platform/email/lambda/dot.mjs` requires DMARC and a verified Cognito `email` in `family_assistant`, then Dot's email worker replies. To make a tool usable by Dot: `delegated = true`,
publish `/family/delegation/<group>`, serve `GET /dot` (validate it with `validateManifest`), accept the
delegated client id in its token check, refuse non-GET from it except the writes it declares (derive that list
with `writeRoutes(MANIFEST)`, so the two can't drift). No Dot code change. If it runs things on its own
or texts people, give those operations their roles.

### Family groups

Groups of people ("Kids") are kept once, in `platform/family`, and edited by `family_admin` at
dot-y.co/family. Tools read them (IAM GetItem/Query on `family-people`, via `platform/api/people.mjs`,
cached a minute) and grant by **group id** (`group:<id>`), so a deleted group's grants never come back
with a new group of the same name. What a group may do stays in each tool's own grants. These groups
are not access to tools: that's each tool's Cognito group, and the family API can't touch those.

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
- `platform/family` before core (core's dot-y.co/family page reads its API URL).
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
| `/family/calendar/google-key` | SecureString: the Google service-account key calendars are shared with; read only by `tools/calendars` |
| `/family/chamber/device-key` | SecureString, set by hand: the chamber board's key for `POST /ingest` (also in its gitignored `arduino_secrets.h`) |
| `/family/house/relay-key` | SecureString, set by hand: the house relay's key for its WebSocket `$connect` (also in the relay container's `/etc/house-relay/house-key`) |
| `/family/people/table-arn`, `/family/people/api-url` | The family's groups and names (`platform/family`): tools read the table; dot-y.co/family calls the API |
| `/family/sms/optin-url` | The SMS opt-in endpoint, for the public page |
| `/family/sms/sends-table-arn` | The table behind the daily limit on what Dot-y sends someone unasked (`platform/api/send-limit.mjs`); House's notify, Lists' sweep and Dot's scheduled runner may get and put there (apply `tools/sms` first) |
| `/family/sms/twilio` | SecureString, set by hand: Twilio API key for sending `{accountSid, apiKeySid, apiKeySecret, messagingServiceSid}` |
| `/family/sms/twilio-webhook` | SecureString, set by hand: `{accountSid, authToken}`, only for the webhook's signature checks |
| `/family/assistant/sms-worker` | Dot’s SMS worker Lambda, which only the SMS webhook may invoke |
| `/family/assistant/email-worker` | Dot’s email worker Lambda, which only the dot@ gate in `platform/email` may invoke (apply the assistant first) |

## Tool notes

Per-tool notes load when you work in that tool: `tools/budget/AGENTS.md` (docs, versions, tags, plans),
`tools/finances/AGENTS.md` (deployments, sync, line ids, filing precedence), `tools/assistant/AGENTS.md` (Dot).
Read them first when a change crosses into one of those tools (e.g. Dot or Finances reading Budget).

- **Finances: never change the description of the `simplefin` SSM parameter**: rewriting a SecureString can
  replace its value (the live access URL). The module keeps it byte-for-byte.

### Others
- **House Hunt**: `rev`-checked writes; SES → bucket → ingest Lambda (`api/ingest.mjs`, bundled by `npm run build`) that accepts
  allowed senders with DMARC passing and has Claude extract listings as untrusted data into a fixed schema.
- **Chamber**: the board can't sign in, so `POST /ingest` has no authorizer; `api/ingest.mjs` checks the
  `x-chamber-key` header against the SecureString `/family/chamber/device-key` (set by hand) and its role can only
  write readings. Control runs on the Arduino; nothing in the cloud may become part of its loop. Firmware notes in
  `tools/chamber/AGENTS.md`.
- **Links**: sections (each its owner's until shared, like a list) + http(s)-only links. **Tempi**: the course HTML is in the Lambda, served only to
  members. **Biomap**: `collection/` is gitignored; `scripts/publish.sh` builds the deck and syncs photos
  to a private bucket. **SMS**: consent text in `api/program.mjs` must match `portal/sms.html` (tested);
  the opt-in Lambda can only write the consent table. Photos texted or emailed to Dot are kept 7 days (privacy page says so; a test ties them). Dot’s texts never carry links (the campaign
  is registered without them); Twilio’s Advanced Opt-Out sends the STOP/HELP/START replies, the webhook records them. **Email**: SES inbound, forwarded with Reply-To; dot@ goes to Dot (`dot.tf`), not forwarded.

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
