# In-person QR pairing: client-side key transfer prototype

**Status: protocol candidate, draft. Not a complete membership protocol.**
Tracks #5 and security gate S2 in draft PR #12.

The product rule remains **QR-only, in person**. No copy-link, messaging,
email, shared URL, or remote-fallback UI may be added. The QR text produced
by this module is intended to be rendered on the owner's screen by a future
UI. A QR is nevertheless a **bearer capability**: a photograph, screenshot or
forwarded QR can be redeemed remotely. The protocol cannot prove proximity.

## Why it can work when the owner goes offline

1. The owner creates a 32-byte random one-time QR seed and invitation ID.
2. HKDF-SHA-256 with explicit domain separation derives **independent**:
   - an AES-GCM key for a package containing the *current epoch* list key;
   - a redemption token. The server stores its SHA-256 commitment.
3. The owner encrypts the package locally under the QR-derived AES-GCM key,
   signs the complete ciphertext and metadata using its P-256 signing key,
   and uploads ONLY the signed ciphertext, public signing key, expiration and
   redemption commitment. **Never upload the QR seed**.
4. The owner displays a short-lived (maximum 10-minute) QR text encoding:
   version, list ID, invitation ID, expiry, owner public-key fingerprint and
   the seed. The QR is removed from the display after use/expiry/cancellation.
5. The recipient scans the QR and derives a redemption token from its seed.
   The full QR text/seed **must never be transmitted to the server**. The
   recipient's future authenticated enrollment request carries the redemption
   token and new device's **public** keys plus a proof-of-possession signature.
6. Cloudflare's per-list Durable Object **must atomically** check the token
   commitment, expiry, cancellation state, owner authorization, epoch and
   unused status; then bind the first successful redemption to the recipient
   signing key and record a unique member ID. Simultaneous attempts cannot
   both succeed, and retries with ambiguous outcomes require an idempotent
   challenge/receipt protocol.
7. The recipient obtains the encrypted package and verifies the QR's owner
   public-key fingerprint, owner signature, list ID, invite ID, epoch and
   expiry before locally decrypting the list key. The owner no longer has to
   be online to complete key transfer.

This PR implements **steps 1–4 and client-side derivation/verification for
steps 5 and 7 only**, in `v2/qr-pairing.mjs`. There is no server enrollment,
recipient key binding, revocation enforcement, or QR rendering.

## Data boundary and API

```js
const { qr, serverRecord } = await prepareQrInvitation({
  listId, ownerId, epoch, listSecret,
  ownerPrivateKey, ownerPublicJwk,
});
// Only after authenticated server registration succeeds, display qr.
// The QR may be rendered into a QR symbol locally, never sent to a remote
// QR generation API or analytics provider.

const { listId, inviteId, token } = await prepareQrRedemption(scannedQr);
// Send only token (+ signed recipient enrollment), not scannedQr or seed.
// A server MUST consume the token once and return signed invitation material.

const imported = await openQrKeyPackage({
  qr: scannedQr, serverRecord: authenticatedServerPackage,
});
// This verifies the owner's signature and returns the current listSecret,
// but IT DOES NOT establish recipient membership.
```

On browser platforms that need camera-compatible URLs, the QR may be encoded
as a versioned URL containing the **entire token only in the fragment**.
Do not use query parameters. Browser history, screenshots and same-origin
malicious JavaScript remain risks even when fragments are not sent in HTTP.

## What single-use actually means

**Single-use applies to membership enrollment, not to decryption capability.**
Anyone possessing both the QR text and encrypted package can derive the
transferred epoch list key, even after the invitation has been consumed or
cancelled. The backend cannot erase a photographed QR, revoke an already
exposed key, or authenticate physical presence.

Consequently:
- A photographed/forwarded QR may be redeemed *first* by an attacker.
- After server registration, expired/reused/cancelled invitations must fail
  even if an attacker can still decrypt a previously obtained package.
- Removing a member requires key-epoch rotation (the old epoch is already
  known), not just removing their token from a server table.
- The server **must** authenticate owner authority for invitation issuance
  and prevent replay or post-revocation creation.
- Server-provided recipient public keys must be authenticated by
  proof-of-possession before member registration.
- A malicious server can withhold availability/freshness; its membership
  authorization alone is insufficient for a complete hostile-server model.
  Signed membership transitions and epoch policy remain design gates.

## Wire format and limits

The signed `serverRecord` is an experimental version 1 JSON object with
exact validated fields. The signature covers an explicitly constructed
ordered header and encrypted data (ECDSA P-256/SHA-256). The public key is
verified against the SHA-256 fingerprint embedded in the physical QR. The
AES-256-GCM 96-bit random nonce and AAD bind list, invitation, owner, epoch,
expiry, fingerprint and commitment.

The QR is prefixed `panier-v2-qr.` and carries compact base64url JSON.
The prefix is distinct from v1 pairing links. The 32-byte seed is random,
the redemption token and encryption key are **domain separated** by HKDF,
and the server receives only the token or its commitment, never the seed.
The owner public key fingerprint is a trusted binding **only to the extent
that the physical QR itself is trustworthy**.

Before production: review canonical encoding, signature algorithm, nonce
selection, QR payload length/scannability, clock skew, key lifecycle,
enrollment recovery, partial writes, consume/register races, and Web Crypto
interoperability. Tests here do not constitute an independent security audit.

## Tests

`node --test test/v2-qr-pairing.test.mjs` covers:
- in-person key round-trip and separated redemption token;
- encryption randomness and distinct invitation IDs;
- expiration and malformed QR handling;
- owner signing key substitution, wrong fingerprint and swapped package;
- tampering of ciphertext/signature, list/epoch/owner bindings;
- a negative guarantee: without a server-side atomic redemption table,
  the *same QR can still be parsed and used repeatedly*.

The tests use a synthetic owner identity and local Web Crypto, no actual
Cloudflare service. CI runs them together with prior v2 suites.

**No production files, endpoints or v1 data were modified.**
