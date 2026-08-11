import { describe, it } from "vitest";

/**
 * Live-account integration tests — skipped (SPEC §6: "I will do the manual
 * OAuth test myself — you cannot click a consent screen").
 *
 * To run these you need a real, consented connection:
 *   1. Run locally (or deploy) with MS_* and/or GOOGLE_* env set and the
 *      redirect URIs registered in Entra / Google Cloud.
 *   2. Sign in, open /connections, connect the account, complete consent.
 *   3. Set TEST_ORG_ID / TEST_USER_ID to that connection's row and change
 *      `describe.skip` to `describe`.
 *
 * They are deliberately end-to-end: they exercise refresh-token redemption,
 * which cannot be mocked meaningfully.
 */
describe.skip("provider clients against a live consented account", () => {
  it("redeems the refresh token and persists the rotated one", async () => {
    // providerClientFor(TEST_ORG_ID, TEST_USER_ID) → mocked === false
    // client.listCalendars() succeeds; provider_connections.last_refreshed_at
    // moved. Microsoft rotates the refresh token here; Google does not.
  });

  it("sends one real mail (SPEC §9 phase 7 gate)", async () => {
    // client.sendMail to a mailbox you control. Microsoft returns a null
    // message id (202 Accepted); Gmail returns a real one.
  });

  it("creates one all-day event with an attendee", async () => {
    // createEvent over two work days; the attendee address you control gets an
    // invite and accept/decline round-trips to the organiser. Check the event
    // spans the right days on both sides — the exclusive-end conversion is the
    // easiest thing to get off by one.
  });

  it("marks the connection needs_reauth when the grant is revoked", async () => {
    // Revoke at account.live.com/consent/Manage (Microsoft) or
    // myaccount.google.com/permissions (Google), call again, and assert
    // ProviderAuthError plus status = needs_reauth (the banner appears).
  });

  it("keeps sending through the other account when one goes stale", async () => {
    // With both connected and Outlook primary: revoke Outlook, then send.
    // providerClientFor falls through to the active Google connection rather
    // than dropping to a simulated send.
  });
});
