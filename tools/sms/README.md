# SMS program (Dot-y)

Dot-y family assistant texts (reminders, to-dos, answers) to people invited by their household, operated by Luke Doty and sent from
(864) 568-4810 through Twilio (US A2P 10DLC, Sole Proprietor brand).

| Where | What |
|---|---|
| `platform/core/portal/sms.html` → https://dot-y.co/sms | Join page with an optional texts box (the call to action carriers verify) |
| `platform/core/portal/privacy.html` → https://dot-y.co/privacy | Privacy Policy |
| `platform/core/portal/terms.html` → https://dot-y.co/terms | SMS Terms |
| `api/program.mjs` | Program facts and the exact consent text (the page must match; a test checks) |
| `api/optin.mjs` | Public `POST /optin`: stores a sign-up, plus a consent record when the box is checked, and texts the opt-in confirmation (once per number) |
| `api/webhook.mjs` | Twilio's `POST /twilio`: records STOP and START, and hands opted-in members' texts to Dot |
| `platform/api/twilio.mjs` | Signature check and sending (symlinked here and into the assistant) |
| `infra/` | Table `dot-y-sms-consent` (deletion protected, PITR), both Lambdas, HTTP API (throttled, CORS dot-y.co only) |
| `infra/sends.tf` | Table `dot-y-sends`: the daily limit on what Dot-y sends someone unasked, 50 across all tools (`platform/api/send-limit.mjs`); House's notify, Lists' sweep and Dot's scheduled asks count there before sending |

Texts must stay optional: Twilio rejected the campaign (error 30923, forced consent) when the box
and the phone number were required. The form joins Dot-y with a name and email; the number and the
box are optional, and tests keep it that way.

Rows: sign-ups `pk = SIGNUP#<email>`, `sk = AT#<ISO time>`, with name, phone (if given), `texts` and where
it came from. Consent records (box checked only): `pk = PHONE#<E.164>`, `sk = CONSENT#<ISO time>`, with name, the exact consent text and
version, the page URL, IP address and user agent. Texting START adds a consent record too (`consentVersion: "keyword"`),
and STOP adds `pk = PHONE#<E.164>, sk = OPTOUT#<ISO time>`; the newest of the two decides whether a number is opted in.
`sk = WELCOME` marks that a number got its opt-in confirmation. The opt-in Lambda can only write to the table, never read it.

The public pages live in `platform/core` because they're served from the apex site; after changing the
consent wording, update both `api/program.mjs` and `sms.html`, bump `CONSENT_VERSION`, and apply this
root and then `platform/core` (core reads the opt-in URL from SSM `/family/sms/optin-url`).

## Texting Dot

```
Twilio ─POST /twilio─▶ dot-y-sms-webhook ──async invoke──▶ lukes-assistant-sms (tools/assistant) ──▶ Twilio API ─▶ the texter
          (signed)      signature, keywords,                runTurn() as that person, channel sms
                        opted in?, member?
```

The webhook answers Twilio right away; Dot's worker texts the reply when the turn is done. A text
reaches Dot only if the number is opted in **and** is the verified `phone_number` of exactly one
Cognito user in `family_assistant` (only an admin can mark a number verified). An opted-in number
that isn't a member's gets a short note; anything else gets no answer.

**Photos (MMS):** the webhook passes up to four images (JPEG, PNG, GIF, WebP) as Twilio media links,
only ones under this account's `api.twilio.com/…/Media/ME…` (the worker signs in to them with the API
key), and counts other attachments. Dot's worker downloads each (3.75 MB at most, Bedrock's limit), deletes it
from Twilio, and shows it to Claude; Dot keeps it 7 days for later turns (tools/assistant README, “Photos”;
dot-y.co/privacy says so). Attachments that didn't come through are noted to Dot.

**Twilio setup** (console, Messaging Service that carries the campaign):

- Credentials in SSM, set by hand (never in OpenTofu state), split so nothing that sends texts holds the Auth Token:
  - `/family/sms/twilio`: `{"accountSid":"AC…","apiKeySid":"SK…","apiKeySecret":"…","messagingServiceSid":"MG…"}`:
    a Standard API key (Account → API keys), used to send by the opt-in Lambda and Dot's worker. Revoke it and make a new one at will.
  - `/family/sms/twilio-webhook`: `{"accountSid":"AC…","authToken":"…"}`: the webhook checks Twilio's signatures with it
    (Twilio signs with the Auth Token; an API key can't verify them). Rotating the Auth Token means updating this one.
- Integration → incoming messages: send a webhook to `tofu output twilio_webhook_url` (HTTP POST).
- Opt-out management (Advanced Opt-Out) sends the registered replies. Twilio sends them, the webhook only records:
  - HELP: “Dot-y: reminder and assistant texts. For help, email contact@dot-y.co. Msg & data rates may apply. Reply STOP to opt out.”
  - STOP: “Dot-y: You have been unsubscribed and will receive no more messages from this number. Reply START to resubscribe.”
  - START: the opt-in message (`OPT_IN_MESSAGE` in `api/program.mjs`).
  - Remove **YES** from the opt-in keywords: people answer Dot with “Yes”, which must reach Dot, not re-subscribe them
    (the webhook already passes “Yes” to Dot).

Deploy order: `npm run build`, `tools/assistant/infra` (publishes the worker at SSM
`/family/assistant/sms-worker`), then this root.
