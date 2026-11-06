# Panier v2 signed membership ledger — experimental protocol candidate

**Do not merge, expose as an API, or deploy without independent protocol review.**
Tracks issues #4, #5, #6 and the S1–S4 blockers in draft architecture PR #12.

This module adds a *list-scoped, append-only membership history* intended to
live in the same Cloudflare Durable Object transaction space as PR #20's
single-use QR invitation registry. The v1 Worker and Wrangler settings are
unchanged.

## Trust and protocol

1. On first list creation, the owner locally creates an ECDSA P-256 key pair
   and signs a **genesis** statement fixing list ID, owner ID and owner
   signing public key. `bootstrapLedger` rejects an untrusted genesis key,
   but **the client must independently pin the owner's real genesis public
   key**. A server-generated or server-substituted key is not an acceptable
   trust anchor. There is no bootstrap UI or recovery procedure yet.
2. The ledger stores an append-only sequence of membership events under
   `membership:event:000000000001`, etc., plus a derived materialized head
   under `membership:state`. Each event is bound to the SHA-256 hash of the
   preceding event. A client may replay the complete chain with
   `verifyMembershipHistory(events, trustedOwnerPublicJwk)`.
3. **Join events** record the owner's signed, list/epoch-scoped QR invitation
   grant and the recipient's signed proof of possession of the new signing
   key. The enrollment statement (version 2) also **signs a separate P-256
   ECDH agreement public key**. The ledger records both independently:
   the signing public key and the recipient's authenticated ECDH public key.
   A join cannot be replayed using the same invitation ID or member ID.
   The QR registry's `registerMember` hook writes this evidence and its
   derived state **inside the same transaction** as invite consumption and
   membership registration.
4. **Rotation events** are explicitly signed by the currently pinned owner
   signing key, require `epoch = previous epoch + 1`, and name one existing
   active member to revoke. Simultaneous competing rotations fail by
   sequence/head mismatch. Old-epoch QR redemption is blocked by
   `authorizeEnrollment` checking current ledger epoch *inside* the
   redemption transaction.
5. `ledgerAuthorizers(storage)` supplies QR registry's `authOwner`,
   `authorizeEnrollment`, and `registerMember` callbacks. Owner checks
   happen both before and during invite registration, reading the **same DO
   transaction snapshot**; consume-time checks run inside the same transaction.
   Cancelling an invitation also requires an **owner-signed cancellation
   statement**. A public signing key or owner ID alone does not confer
   cancellation authority.

## Important limitations — these are hard security gates

- **Owner recovery/transfer is NOT implemented.** There is one owner key in
  this prototype; changing owner authority and invalidating old recovery
  kits will require a separately reviewed signed transition.
- **ECDH authentication is not ECDH private-key proof.** A member's signing
  key authenticates their chosen agreement public key; possession of the
  corresponding agreement private key is only demonstrated by successfully
  decrypting a recipient-specific key package. An explicit confirmation
  handshake is still required before treating delivery as complete.
- **Rotation is NOT rekeying.** The ledger can advance an epoch and revoke
  membership, but cannot itself distribute a new list secret or prevent a
  removed member from reading ciphertext already obtained. Never permit
  production use of a new epoch until key delivery and old-epoch queued-write
  rules are specified and tested.
- An append-only hash chain detects alteration of history *if* the client
  has a pinned genesis and receives all committed events. A malicious server
  can still **withhold a suffix of the log**, equivocate by presenting
  alternate prefixes, or suppress operations. Client-pinned head checkpoints,
  receipts and consistency/freshness rules are required.
- The server's `membership:state` is a cache, not a cryptographic truth
  source on its own. The client must verify event history and pin the
  genesis/head. The current DO adapter uses a materialized cache for fast
  authorization; complete persistence tamper handling is NOT implemented.
- A photographed QR still reveals the current epoch key. Single-use
  redemption prevents additional *memberships*, not leaked-key decryption.
- QR issuance and enrollment retain a signed grant and proof of possession,
  but **owner authority at list creation and recipient identity across
  recovery remain unimplemented**.
- The proof format uses experimental ordered JSON and P-256 signatures;
  canonical encoding/test vectors and external crypto audit remain required.
- There is **no Worker endpoint, Wrangler binding or production integration**.
  The DO transaction contract is tested with a serializing, rollback-capable
  mock, not a deployed Cloudflare Durable Object runtime.
- Successful member enrollment response receipt after network loss, rate
  limiting, invitation quotas and garbage collection need dedicated work.

## Testing

`node --test test/v2-membership-ledger.test.mjs` tests:
- genuine owner-signed pinned genesis, rejection of substituted roots;
- join event with signed invitation grant and recipient proof;
- two competing scans yielding one accepted membership history event;
- signed epoch change, denied stale epochs and invalid rotation signatures;
- detection of tampered grants, substituted ECDH agreement keys, chain
  ordering and replay, and verified recipient selection for rekey;
- transaction rollback without partial event, member or QR use.

Existing reducer, cryptography, QR and IndexedDB browser tests continue to
run. Their green status **does not replace independent protocol review**.

## Reviewer priorities

See `docs/v2-security-review-brief.md`. In particular, question whether
server-supplied head/epoch status could permit malicious acceptance, whether
owner-signed invitation plus recipient proof is a sufficient join transcript,
and how clients pin and compare verified log heads.

No data is migrated, no current v1 application code is touched, and
Raspberry Pi/Go is outside v2 scope.
