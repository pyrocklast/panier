# ADR-0002: Approved product decisions and security review gates

Status: **Product decisions approved 2026-11-06; protocol design under review**  
Tracks: [#2](https://github.com/pyrocklast/panier/issues/2), [PR #12](https://github.com/pyrocklast/panier/pull/12).

This record separates **decisions approved by the product owner** from
**cryptographic implementation details that are not yet approved**.
It supplements [ADR-0001](./0001-panier-v2.md) and the
[v1 → v2 migration plan](../v2-migration.md).

## Decided: owner recovery and transfer

**Choice:** encrypted recovery kit **plus optional explicit ownership transfer**.

- The owner can export recovery material locally and store it outside Panier.
- The kit must contain or enable recovery of both the list decryption secret(s)
  and the authority to regain owner access on a fresh browser installation.
  Exporting only a content key is insufficient to regain server permissions.
- The kit must be protected and authenticated; recovery secret disclosure
  carries serious consequences. The server cannot decrypt or reset it.
- Owner transfer is explicitly initiated by the current owner and targets
  an existing active member. It must be an authenticated operation recorded
  atomically, not a display-name change.
- Transfer must specify what happens to the previous owner's authority.
  The simplest initial policy is **one active owner** and a transfer which
  demotes the old owner to member. The old owner can then be revoked separately;
  revocation triggers key rotation.
- No automatic "next oldest member becomes owner" and no server-admin reset.
  If all owner/recovery authority is lost, ownership may be unrecoverable.

**Pending security design:** recovery kit format and user secret requirements;
authenticated restoration of an owner credential; whether recovering from a
stolen old kit is possible after rotation; anti-replay transfer challenges;
what happens during concurrent transfer and revocation; owner device loss
while other members are still online.

**Required tests:**
- Recover decryption **and** authorized owner role on a clean browser.
- Wrong password, wrong list, tampered kit and revoked recovery capability fail.
- Lost original owner device does not prevent recovery with a valid kit.
- Stale owner credential and replayed transfer are rejected.
- Ownership transfer does not accidentally grant cross-list privileges.

## Decided: invitations by link, no owner approval

**Choice:** owner-issued, cryptographically random **single-use link**.
An unused link is revocable and may expire. Opening a valid link is enough
to initiate joining; no separate owner approval is required.

- The full invitation URL is a bearer capability: whoever obtains it before
  redemption can potentially join. The UI must communicate this without
  implying that the server verifies the invitee's real-world identity.
- A server-side record atomically tracks valid/redeemed/revoked/expired status
  and scopes it to one list and its intended membership permissions.
- Encryption/key-transfer material remains client-side; no plaintext list
  keys in API requests, logs or analytics.
- The successful join produces a **new per-list member identity** and an
  authenticated key envelope. The owner retains the ability to revoke that
  member later and rekey future content.
- Clearing the fragment from the address bar does not retroactively make
  previously shared URLs safe.

**Pending security design:** exact one-round-trip vs two-round-trip
enrollment protocol, binding the invitation capability to the recipient's
public keys, who constructs the key envelope if the owner is offline,
envelope issuer authentication, handling multiple redemptions and partial
failures. This is a core architectural problem: **a link usable while its
owner is offline must transfer key material without allowing the server to
read or silently substitute it**. Do not ship an invented unauthenticated
public-key exchange.

**Required tests:**
- Valid first redemption succeeds; second, concurrent, expired or revoked
  redemption fails without creating a usable unauthorized membership.
- Recipient can verify the list identity and authenticated envelope.
- Forged or swapped recipient public key, envelope and list ID are rejected.
- Invitation secret and plaintext list key never reach server logs/requests.
- Key theft/replay behavior and message-leak limitations are documented.

## Decided: v1 → v2 explicit copy

**Choice:** an explicit **Copy to Panier v2** operation.

- No in-place migration and no auto-update of v1 browser/server state.
- Create a new v2 list with fresh random list ID, keys and membership.
- Leave the v1 list accessible and warn that the copies will diverge.
- If the local v1 device has an unsent outbox, present honest status and
  preserve those pending edits rather than silently discarding them.
- A separate validated export/recovery path is required before inviting
  users to stop using v1.
- Raspberry Pi / Go implementation remains out of scope.

See [migration acceptance tests](../v2-migration.md) for retry, rollback
and fidelity requirements.

## Remaining security protocol decisions (blocking)

The product decisions above are settled. The following have **not** been
security approved; mark them as protocol acceptance gates, not new product
questions.

| Gate | Technical decision / required evidence |
| --- | --- |
| S1 — Ownership and recovery | Exact recovery kit schema, key protection, recovery credential rotation/invalidation; signed atomic transfer and replay prevention; clean-browser recovery tests |
| S2 — Link/key-envelope handshake | Versioned handshake, recipient key binding, authenticated issuer, offline-owner path or documented limitation; concurrent/single-use redemption tests |
| S3 — Revocation/key epochs | Fence old-epoch writes, distribute keys safely to remaining authorised members, handle offline clients and queued edits without silent loss; adversarial concurrent/restart tests |
| S4 — Wire cryptography | Canonical signed bytes, algorithm suite (ECDSA/ECDH or reviewed alternative), HKDF contexts, AEAD nonce construction, AAD, envelope versioning and failure handling; independent security review |
| S5 — Retention and recovery | Bound storage cost, authenticated encrypted snapshots, safe compaction conditions, encrypted backup restore and rollback; tests before log deletion |
| S6 — Browser and server trust | Deployment controls, hostile-server limitations, local plaintext exposure, replay/downgrade protection, Web Crypto compatibility checks |

## Review and merge policy

- [x] Product-owner decision: recovery kit + optional ownership transfer.
- [x] Product-owner decision: single-use invitation links without approval.
- [x] Product-owner decision: explicit, non-destructive v1 → v2 copy.
- [ ] Review S1/S2 to ensure accountless recovery and link invitations can be
      implemented together without a hidden key escrow service.
- [ ] Review S3/S4 with a security reviewer; produce interoperable test vectors
      and explicit error states before writing production cryptography.
- [ ] Review S5/S6 and migration failure/rollback tests before rollout.
- [ ] Confirm the ADR is internally consistent, then approve PR #12.

**PR #12 remains draft** until the protocol is sufficiently specified and
reviewed. No change in this document authorizes deployment or implies that
end-to-end encryption has undergone independent review.
