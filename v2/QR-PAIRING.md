# Panier v2 — strict in-person QR pairing protocol candidate (#5)

**Status: draft cryptographic package prototype. NOT a complete pairing protocol,
NOT security-reviewed, NOT wired to the PWA or Cloudflare Worker.**

The product decision is **QR-only, in person**, with no remote link-sharing
button, copy-link action, QR export, SMS/email invitation flow or fallback.
A QR can still be photographed or forwarded; the protocol **does not prove
physical proximity**. A stolen unredeemed QR is a bearer capability.

## Client-side package (implemented)

`prepareQrInvitation` runs on the owner's device **before** displaying a QR.
It generates two independent 256-bit secrets:

- **key**: decrypts a pre-encrypted AES-256-GCM package containing the current
  list key and epoch. Never sent to Cloudflare.
- **redeem**: used as a single-use membership *redemption capability*.
  The server stores a SHA-256 commitment, not the raw secret, before redemption.
  Redemption necessarily discloses the redeem token to the server, but
  **never discloses the separate list-key decryption secret**.

The owner signs the package with its ECDSA P-256 private key. The signing bytes
cover the version, list ID, invitation ID, owner/issuer ID, key epoch,
expiration, redemption commitment, random nonce and ciphertext. AES-GCM AAD
binds the same metadata. The owner public JWK may be stored with ciphertext;
the scanner verifies its **SHA-256 SPKI fingerprint matches the QR's owner
fingerprint** before verifying the owner signature. A server that replaces the
public key cannot silently replace the list key without also replacing the QR.

The QR string has a versioned `panier-v2-join:` prefix and contains:
`{v, invitationId, listId, key, redeem, ownerFingerprint}`. Its entire
contents are **sensitive**; do not put them in a URL query, HTTP body, logs,
analytics, browser history, error reports, copied text or remote-share UI.
A future scanner should read the QR data directly in the PWA. The module
does not generate QR images or call a camera.

The server stores the **encrypted package**, its owner public key, invitation
ID/list ID/expiration, and redemption commitment. It must authenticate the
owner before allowing package creation and check that the current key epoch
was valid when created. The package allows owner-offline redemption *once
already registered*.

## Proposed online redemption handshake (NOT implemented)

1. A new installation generates a fresh **non-extractable signing identity**.
   It scans the QR directly in the PWA.
2. The recipient contacts the Cloudflare list DO with list+invitation ID,
   redemption token and recipient public key **plus proof-of-possession**
   signature over a server-issued unpredictable challenge and the full
   invitation/list context. A public-key string alone is insufficient.
3. The DO atomically checks: invitation active and unexpired, commitment
   matches, requesting list matches, owner/issuer still authorized, epoch
   still valid, token not used, and no race has already consumed it.
   **One transaction must consume the invitation AND register the public key
   as a list-scoped member.** Concurrent uses must not both succeed.
   An already revoked/expired invitation cannot authorize a member.
4. The DO returns the encrypted package and an authenticated, signed
   membership receipt containing the assigned member identity, list,
   epoch, recipient public-key fingerprint, invitation ID and result.
   The exact server receipt / client trust model is **not defined yet**.
   A backend success flag alone cannot ensure a malicious server has not
   substituted the recipient's membership or lied about revocation.
5. The scanner verifies owner public-key fingerprint from QR, owner
   signature, authenticated package metadata and AES-GCM tag, then imports
   the list key. It must **not** persist that key merely because a caller
   sets `claimConfirmed: true`. This flag is a test/prototype assertion;
   production code must validate the authenticated membership result.
6. The joining device can start downloading authenticated encrypted changes
   only after membership authorization and key material are in sync.

**Unresolved design conflicts:** this prototype uses a **server-issued
single-use bearer redemption token**. A stolen QR can race the recipient;
the server can lie or compromise availability; and the recipient's
public key binding/receipt needs rigorous specification. Physical presence
is a product workflow, not authentication of the device in the room.

The owner can cancel an unused QR, and the UI should automatically hide it
after 10 minutes (default maximum). The **server** must enforce expiry and
one-time use; client-side clock checks are only UX/fail-closed hints.
Revocation of an already joined member requires a separate epoch rotation.
No join operation is allowed for an old epoch after rotation.

## Implemented API

- `prepareQrInvitation({listId,epoch,listSecret,issuerId,ownerPrivateKey,ownerPublicKey,now,lifetimeMs})`
  returns `{qrText,record,serverMetadata}` with **no plaintext list key
  in the server record**.
- `parseInvitationQr(qrText)` validates the QR payload and canonical ordering.
- `deriveRedemption(qrText)` exposes only the redemption token needed in a
  future backend claim, **not** the decryption key.
- `openQrInvitation({qrText,record,now,claimConfirmed})` checks expiry and
  cryptographic owner/list/epoch binding and decrypts. **Not authorization.**

The P-256 owner signing key is not a QR-exclusive key. The future protocol
must bind the issuer to a *trusted list owner role* and forbid a normal member
from issuing invitations.

## Recipient key proof-of-possession (client prototype)

`v2/qr-enrollment-proof.mjs` now implements the **client's half** of
proof-of-possession: a new anonymous P-256 identity signs a domain-separated
transcript covering list ID, invitation ID, fresh 256-bit server challenge,
actor ID and canonical public signing key. The pure verifier rejects
substituted list/invitation/challenge context, invalid keys and signatures.

**This does not create a member or establish single-use redemption.** A
correctly signed proof can be replayed unless the Cloudflare DO issues an
unpredictable challenge, binds it to an invitation, enforces expiration,
and **consumes it atomically with the membership grant**. Tests deliberately
show that repeated cryptographic verification succeeds in the absence of
server-side replay tracking. Challenge issuance, public key registration,
authorization and receipts remain security gates.

Run `node --test test/v2-qr-enrollment-proof.test.mjs`.

## Security/ship blockers

- [ ] Server-side owner-authenticated, expiring, revocable, **atomic**
      invitation creation/claim, enforcing single use and epoch fencing
- [x] Client-side challenge-bound recipient key proof-of-possession prototype
- [ ] Server-side unique challenge issuance/consumption and verified binding
      of a **membership receipt** to the recipient's public key
- [ ] Security-reviewed envelope serialization and cross-browser vectors,
      including QR capacity/accessibility and robust QR generation/scanning
- [ ] Encrypted recovery kit and owner transfer (security gate S1)
- [ ] Revocation/key rotation and offline-member handling (S3)
- [ ] Hostile-server analysis, log scrubbing, rate limits, duplicate/retry
      semantics and threat-model review (S6)
- [ ] Browser E2E pairing with two independent installations, denial cases,
      simultaneous claims and offline-owner simulation
- [ ] Explicitly prevent remote link-sharing and key leakage in the UI
- [ ] Production authorization reviewed independently before merging/deploying

`node --test test/v2-qr-invitation.test.mjs` runs the isolated package tests.
These tests use local cryptography only: they cannot prove backend atomic
redemption, membership validity, issuer authorization or physical presence.

**v1 and Raspberry Pi/Go are unchanged.** This is another stacked draft PR.
