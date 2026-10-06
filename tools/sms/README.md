# SMS program (Dot-y)

Dot-y family assistant texts (reminders, to-dos, answers) to people invited by their household, operated by Luke Doty and sent from
(864) 568-4810 through Twilio (US A2P 10DLC, Sole Proprietor brand).

| Where | What |
|---|---|
| `platform/core/portal/sms.html` → https://dot-y.co/sms | Join page with an optional texts box (the call to action carriers verify) |
| `platform/core/portal/privacy.html` → https://dot-y.co/privacy | Privacy Policy |
| `platform/core/portal/terms.html` → https://dot-y.co/terms | SMS Terms |
| `api/program.mjs` | Program facts and the exact consent text (the page must match; a test checks) |
| `api/optin.mjs` | Public `POST /optin`: stores a sign-up, plus a consent record when the box is checked |
| `infra/` | Table `dot-y-sms-consent` (deletion protected, PITR), Lambda, HTTP API (throttled, CORS dot-y.co only) |

Texts must stay optional: Twilio rejected the campaign (error 30923, forced consent) when the box
and the phone number were required. The form joins Dot-y with a name and email; the number and the
box are optional, and tests keep it that way.

Sign-ups: `pk = SIGNUP#<email>`, `sk = AT#<ISO time>`, with name, phone (if given), `texts` and where
it came from. Consent records (box checked only): `pk = PHONE#<E.164>`, `sk = CONSENT#<ISO time>`, with name, the exact consent text and
version, the page URL, IP address and user agent. The Lambda can only write to the table, never read it.

The public pages live in `platform/core` because they're served from the apex site; after changing the
consent wording, update both `api/program.mjs` and `sms.html`, bump `CONSENT_VERSION`, and apply this
root and then `platform/core` (core reads the opt-in URL from SSM `/family/sms/optin-url`).

Next: a Twilio inbound webhook here that runs the assistant's `runTurn()` for texts from opted-in numbers.
