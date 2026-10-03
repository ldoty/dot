// Facts about the Dot-y texting program, shared by the opt-in API and its tests (the public
// pages in platform/core/portal show the same values; a test keeps them identical).
export const PROGRAM = {
  name: 'Dot-y',
  operator: 'Luke Doty', // must match the Twilio Sole Proprietor brand exactly
  number: '(864) 568-4810',
  contact: 'contact@dot-y.co',
};

// The exact consent wording shown next to the checkbox on /sms. Stored with every opt-in.
// Change it only together with the page, and bump CONSENT_VERSION.
export const CONSENT_TEXT = `I agree to receive recurring personal reminder and assistant text messages from ${PROGRAM.name} (${PROGRAM.operator}) at the number provided. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Consent is not a condition of any purchase. See our Privacy Policy and Terms.`;
export const CONSENT_VERSION = '2026-10-03';
