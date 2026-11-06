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

## Decided: strict in-person QR-only invitations (revision 2026-11-06)

**Choice:** pairing happens **only while the owner and recipient are physically
together**. The owner displays a **single-use, short-lived QR code**; the
recipient scans it. No remote link sharing or separate owner approval screen.

- **No** Copy link, Share, SMS, email, messaging, screenshot/export of the QR,
  or remote invitation fallback in the product UI. The QR is shown only in
  the owner's Members → Add someone flow.
- A default 10-minute lifetime is proposed; unused codes can be cancelled.
  Successful redemption immediately invalidates the QR. Show an expiry
  indicator and clear the QR after redemption, cancellation or timeout.
- Creating and redeeming invitations require an internet connection. Once the
  owner has uploaded the encrypted invitation package, they need not remain
  online to complete redemption.
- The QR payload contains an opaque invitation identifier and a high-entropy
  secret needed to decrypt a **pre-encrypted, owner-authenticated** key package.
  A URL encoded for camera compatibility is still a bearer capability, not a
  product feature for remote link sharing. Keep any secret in the URL fragment,
  never request parameters, API bodies or logs.
- The server stores the ciphertext package, invitation expiry/state and
  necessary membership metadata; **not** the QR decryption secret or plaintext
  list key. An atomic consume-and-register transaction binds first redemption
  to the recipient's freshly generated public keys.
- The recipient must verify the signed package's owner identity and list
  binding using a trustworthy fingerprint/binding carried in the QR, before
  importing the list key. Never trust an unverified server-supplied owner key.
- The server cannot prove physical proximity. A QR can be photographed,
  screen-captured, forwarded or scanned from a remote image. Whoever obtains
  it before redemption can potentially join; the UI should describe that
  threat plainly rather than claiming physical-only cryptographic security.
- Pairing remains separate from recovery-kit export/import and owner transfer,
  which are *not* invitation or remote-sharing fallback features.

**Proposed protocol (not yet security approved):** owner creates a random
one-use decryption secret and high-entropy server redemption capability;
locally encrypts the current list epoch key, list/owner binding and invitation
metadata as an AEAD package; signs the public envelope; uploads encrypted
package and redemption commitment; displays invitation ID, redemption
capability, decryption secret, list ID and owner-key fingerprint in QR.
Recipient generates a fresh signing/agreement identity, atomically redeems
the capability to bind their public keys, verifies the authenticated envelope
and imports the key locally. Exact separation of the redemption capability
and the decryption secret, packaging, signature coverage, nonce strategy,
expiry and failed/redemption-race behavior require review.

**Required tests:**
- Valid in-person scan succeeds; second, simultaneous, expired or cancelled
  redemption fails without creating unauthorized membership.
- Recipient can verify owner identity and authenticated list/epoch envelope
  without trusting a server-substituted public key.
- A photographed QR redeemed first behaves as a stolen bearer credential;
  document and test this limit.
- Wrong/mismatched keys, tampered ciphertext, altered QR or swapped owner
  fingerprint must fail closed.
- No plaintext list key, QR decryption secret or complete QR payload appears
  in server requests, network logs or analytics.
- No remote sharing/copy-link action is exposed by the UI.

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
| S2 — In-person QR/key-package handshake | Owner-prepared signed ciphertext, trustworthy owner-key fingerprint in QR, capability/decryption-secret separation, atomic recipient-key binding, expiry and single-use redemption tests |
| S3 — Revocation/key epochs | Fence old-epoch writes, distribute keys safely to remaining authorised members, handle offline clients and queued edits without silent loss; adversarial concurrent/restart tests |
| S4 — Wire cryptography | Canonical signed bytes, algorithm suite (ECDSA/ECDH or reviewed alternative), HKDF contexts, AEAD nonce construction, AAD, envelope versioning and failure handling; independent security review |
| S5 — Retention and recovery | Bound storage cost, authenticated encrypted snapshots, safe compaction conditions, encrypted backup restore and rollback; tests before log deletion |
| S6 — Browser and server trust | Deployment controls, hostile-server limitations, local plaintext exposure, replay/downgrade protection, Web Crypto compatibility checks |

## Review and merge policy

- [x] Product-owner decision: recovery kit + optional ownership transfer.
- [x] Product-owner decision (revised): strict in-person QR-only invitations, no remote link sharing or separate owner approval.
- [x] Product-owner decision: explicit, non-destructive v1 → v2 copy.
- [ ] Review S1/S2 to ensure accountless recovery and QR invitations can be
      implemented together without a hidden key escrow service.
- [ ] Review S3/S4 with a security reviewer; produce interoperable test vectors
      and explicit error states before writing production cryptography.
- [ ] Review S5/S6 and migration failure/rollback tests before rollout.
- [ ] Confirm the ADR is internally consistent, then approve PR #12.

**PR #12 remains draft** until the protocol is sufficiently specified and
reviewed. No change in this document authorizes deployment or implies that
end-to-end encryption has undergone independent review.
