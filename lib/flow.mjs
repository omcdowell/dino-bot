// The setup order, in one place (chosen for the demo, 27 Oct; under review):
//   1 install command  2 Tailscale check (kind steps)  3 QR pair  4 sign-in ON THE PHONE
//   5 optional chat import (off by default, on the phone)  6 first bot replies.
// Each step after pairing can move back into the terminal wizard by flipping one value here
// ("terminal"); the app has the matching list (packages/app/src/constants/flavour.ts
// ONBOARDING_STEPS), so moving a step means changing both lines.
export const SETUP_FLOW = {
  /** "phone": the app asks after pairing (bots plugin RPC signin.*). "terminal": the wizard asks before it ends. */
  signIn: "phone",
  /** "phone": the app's setup card (off by default). "terminal": the wizard's extras checklist. */
  import: "phone",
  /** After the QR, the wizard waits this long for the phone sign-in and then says what happened (0: don't wait). */
  waitForPhoneMs: 10 * 60_000,
};
