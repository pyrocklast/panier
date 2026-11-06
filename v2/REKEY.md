# Panier v2 — post-revocation rekey prototype

**Isolated draft cryptographic component. NOT production-ready, not integrated
into the deployed Worker or sync coordinator. Requires independent review.**

## What this change establishes

When an owner revokes a member, simply increasing the signed membership epoch
does not remove that member's knowledge of the old symmetric list key.

The owner must create a **fresh, independent 32-byte list secret** for the new
epoch. It must be delivered to each remaining authorized device without
revealing it to Cloudflare or to the revoked device.

`v2/rekey.mjs` provides a candidate envelope format:
1. Obtain the owner's **verified, current** signed membership snapshot and
   the signed rotation event/head from the membership ledger (PR #21).
2. Determine the still-authorized devices and their independently trusted
   P-256 **ECDH agreement public keys**, authenticated as part of the
   membership protocol. Signing keys are not reused as ECDH keys.
3. Create a new content secret locally. For each *remaining* device, generate
   a fresh ephemeral P-256 ECDH key, derive a 256-bit AES-GCM encryption key
   with HKDF-SHA-256, and wrap the fresh secret. Include list ID, owner ID,
   receiving member ID, epoch, signed rotation head and the ephemeral key
   in authenticated associated data.
4. The owner signs each individual key envelope with its signing private key.
   Cloudflare stores ciphertext, nonce, public ephemeral key and signature,
   but no content key or recipient private key.
5. A recipient verifies its **pinned owner key**, expected list/member/epoch
   and signed rotation head, then decrypts with its own non-extractable ECDH
   private key. A revoked device does not receive a new envelope and cannot
   decrypt one intended for another remaining device.

The `rotationHead` is supplied externally; this module does NOT itself
verify the membership chain. It must be derived from an already verified
signed rotation event, never accepted as a server assertion.

## Authenticated agreement keys (new stacked integration)

The updated experimental QR enrollment statement (v2) binds the recipient's
P-256 **ECDH agreement public key** to its authenticated P-256 signing key.
The member join event includes the same signed binding. A client that verifies
the entire membership history against a pinned owner signing key can use
`verifiedRekeyRecipients(verifiedState, removedMemberId)` to obtain the
surviving member keys. The helper excludes the owner (who locally generated
the new list secret), inactive members and the removed device.

This blocks an unauthenticated server from *substituting* an agreement key
while the client verifies the signed join transcript.

**Not fully solved:** the signature proves possession of the *signing*
private key, not the ECDH private key. A recipient must demonstrate the
ability to decrypt an owner-signed key package before the sender treats
distribution as completed. An authenticated key-confirmation receipt,
freshness/pinned-head checks and server withholding safeguards still need
protocol design and security review. Neither receiving a key nor reading
the materialized server membership state alone proves this.

## Offline mutations across epochs

The durable outbox stores each operation's **signed, encrypted wire bytes**.
After revocation, pending operations sealed under an old epoch cannot simply
be uploaded (old member permissions may have changed), nor can a signed
envelope safely be encrypted again under the same ID.

`classifyPendingEpochs(pending,currentEpoch)` classifies entries as:
- `ready`: sealed at the exact verified current epoch.
- `quarantined`: sealed under an earlier epoch. Keep the original record and
  ciphertext unchanged, and inform the user that the edit needs resolution.
- Future epoch, corrupt envelope or missing ciphertext: **fail closed**.

A complete reviewed rebase protocol must later reconcile the offline edits
against the accepted log, obtain the current list secret and current member
authorization, assign **new mutation IDs**, sign and encrypt new envelopes,
persist the replacement transactionally, and preserve an auditable link to
the original before releasing pending work. No automatic rebase/retry is
implemented here.

Importantly, this classifier does not authenticate ciphertext and must not
stand in for signature, role, epoch or list-binding checks before upload.

## What is *not* solved

- Verified ECDH public-key binding now exists in signed joins, but recipient
  **private-key confirmation and authenticated delivery receipts** are missing.
- Server enforcement that all required surviving recipients can obtain
  packages before an epoch cutover; safe handling of temporarily offline
  members; atomic publication of signed rotation and key packages.
- Immediate removal of access to ciphertext already downloaded or a list key
  previously photographed from a QR. Cryptographic erasure is impossible.
- Old-epoch append rejection and server-side idempotency for queued writes.
- Distribution retry receipts, encryption-key storage/recovery, snapshots,
  integration with the existing sync coordinator and user-facing warnings.
- Trust in latest server-supplied membership state or rollback/fork detection.
- Independent protocol audit and cross-browser key-envelope test vectors.

## Tests

`node --test test/v2-rekey.test.mjs` includes recipient round-trips,
revoked-device/wrong-device exclusion, tampering/forgery, randomized envelope
generation, unchanged outbox bytes and quarantine for stale offline edits.

Use after reviewer approval, not as evidence that the system is secure.
No production/v1/Go/Raspberry Pi files were modified.
