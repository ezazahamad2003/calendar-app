import { describe, it } from "vitest";

/**
 * Phase 7 integration tests — skipped (SPEC §6: "I will do the manual OAuth
 * test myself — you cannot click a consent screen").
 *
 * To run these you need a live, consented connection:
 *   1. Deploy (or run locally) with MS_* env set and Azure redirect URIs
 *      registered.
 *   2. Sign in, click "Connect Outlook", complete consent with a real
 *      Microsoft account.
 *   3. Set TEST_MS_ORG_ID / TEST_MS_USER_ID to that connection's row, and
 *      change `describe.skip` to `describe`.
 *
 * They are deliberately end-to-end: they exercise refresh-token rotation,
 * which cannot be mocked meaningfully.
 */
describe.skip("RealGraphClient against a live consented account", () => {
  it("redeems the refresh token and persists the rotated one", async () => {
    // graphClientFor(TEST_MS_ORG_ID, TEST_MS_USER_ID) → mocked === false
    // client.listCalendars() succeeds; ms_connections.last_refreshed_at moved.
  });

  it("sends one real mail (SPEC §9 phase 7 gate)", async () => {
    // client.sendMail to a mailbox you control; assert 202 path (null id).
  });

  it("creates one all-day event with an attendee", async () => {
    // createEvent over two work days; attendee address you control receives
    // an invite; accept/decline round-trips to the organiser.
  });

  it("marks the connection needs_reauth when refresh is revoked", async () => {
    // Revoke consent at https://account.live.com/consent/Manage, call again,
    // assert GraphAuthError and status = needs_reauth (banner appears).
  });
});
