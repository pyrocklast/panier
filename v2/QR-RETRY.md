# Panier v2 — safe retry of an interrupted QR enrollment

**Draft protocol change. Not production-integrated, deployed or security-reviewed.**
Stacked on PR #30. Physical QR-only invitations remain the product rule.

A single-use QR invitation can be consumed atomically by a Durable Object
while its HTTP response is lost. Previously a retry, even by the same
device, was rejected, leaving a recipient unable to tell whether enrollment
succeeded.

The isolated `QrInvitationRegistry.redeem` now distinguishes:

- **First successful registration:** consumes the invitation and registers
  the recipient's signing and ECDH agreement public keys in the signed
  membership log and DO member table, in one transaction. Returns
  `alreadyUsed:false`.
- **Retry of exactly that registered identity:** recipient re-presents
  its QR-derived token and freshly signed proof-of-possession. The
  transaction checks the original invite ID, token hash, registered member
  ID, BOTH signing and agreement keys, and that the same signed identity
  is still **active in the current membership ledger**. It returns the
  original owner-signed encrypted invitation package with
  `alreadyUsed:true`, `epoch` (original) and `currentEpoch`, without
  changing membership or consuming another invitation.
- **Different recipient, revoked/cancelled/expired unused invitation,
  invalid token, substituted signing/agreement key or removed member:**
  reject. A retry cannot enroll a second device or silently recover
  revoked access.

An originally consumed QR can be retried by its enrolled device after
the ten-minute invitation deadline because no **new** membership is being
granted. An unused QR cannot be redeemed after expiration. The current
epoch is returned separately because the list might have rotated while
the original recipient was reconnecting. This API does not itself deliver
subsequent epoch keys; member-specific rekey retrieval is separate.

**Important:** this is a bearer QR token plus recipient possession proof,
not physical-presence verification. A photographed QR may still disclose
the original epoch list key, even if the server prevents duplicate joins.

## Security considerations

- The server requires proof of the **same registered signing private key**
  and matching ECDH public key. Claiming an existing member ID alone is
  insufficient; a stolen QR alone cannot impersonate that member.
- Replay does not add signed membership events or overwrite the registered
  public keys. A competing first claim from another device still wins
  atomically and the loser is rejected.
- The identity's current *active* status is required; a removed member
  cannot use an old QR receipt to regain access.
- If the browser loses the enrolled signing private key, replay cannot
  restore identity. The separate owner-approved recovery/pairing flow
  remains necessary.
- Client must locally verify the original owner-signed invitation,
  owner-pinned membership history and a matching signed join record.
  An HTTP `alreadyUsed:true` reply alone is **not** a trust proof.
- Rate limiting, first-write attack, remote QR photography, server
  withholding/equivocation and crypto protocol review remain open.

Tests run against the transactional mock and real local Cloudflare
Durable Object. The deployed v1 application, PWA and Go/Raspberry Pi
implementation are unchanged.
