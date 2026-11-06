# Panier v2 — durable recipient device credentials

**Draft, isolated client-side work. No production PWA integration, no key
export, no new server endpoint. Independent security review remains required.**

QR enrollment registers two different public keys for each device:
a P-256 ECDSA signing identity and a P-256 ECDH agreement key. The
corresponding private keys must survive browser restarts or the device
will no longer be able to authenticate or decrypt new epoch packages.

`v2/member-keys.mjs` creates a dedicated IndexedDB database,
`panier-v2-member-keys`, containing one record per locally joined list:

- list/member ID and the **original owner public-key root** that was
  independently authenticated from a physical QR;
- the member's registered signing and agreement public keys;
- their **non-extractable** Web Crypto signing/ECDH private CryptoKey objects.

The keys are stored as browser-native structured-cloned CryptoKeys, not
as JWK private material, PEM, plaintext export or Cloudflare secrets.

## Required flow

1. Verify the owner's QR and pin its owner-signed root in the separate trust
   store using `pinOwnerFromScannedQr`.
2. Generate fresh non-extractable signing and ECDH keypairs. Call
   `saveNewMemberKeys` **before making the QR redemption HTTP request**.
   The module locally signs a challenge to prove the signing private/public
   key match, and performs ephemeral ECDH agreement to prove the stored ECDH
   private/public key match. It refuses duplicate credentials for the same
   list instead of replacing keys.
3. Use `readPendingMemberKeys` if a QR response is lost. It retrieves the
   original two local private keys and their public metadata, but **does
   not assert server membership**; the client must still submit its
   authenticated original QR invitation claim and verify its signed join.
4. After the signed membership log contains the new active member,
   `readAuthorizedMemberKeys` verifies the full owner-rooted history,
   compares **both** enrolled public keys with the persisted local keys
   and atomically extends the trust checkpoint before returning keys for
   signed API requests and rekey decryption. A removed member fails closed.

This also means closing/reopening the browser does not force generation
of new identities just to retry a response or resume a verified list.

## Important security and reliability limits

- **The QR seed is not persisted.** A lost enrollment response followed
  by a browser restart still needs the original physical QR capability
  available through an explicitly trusted scanning flow. Storing the QR
  decryption seed for delayed retries requires a separately reviewed
  encrypted local capability lifecycle, not a plaintext database field.
- Storing non-extractable CryptoKeys does **not** protect against
  compromised same-origin JavaScript. Malicious code can use these keys
  through Web Crypto, alter the IndexedDB records, steal decrypted list
  content or suppress access.
- Browser IndexedDB may be cleared or evicted. Persistent storage is not
  backup. Owner recovery, recipient re-enrollment and cross-device
  transfer must follow the separate reviewed recovery protocol.
- There is no support for replacing the member's signing/ECDH keys,
  multiple member identities in one browser for the same list, or
  owner-transfer authority in this prototype.
- This module persists **identity keys only**. New epoch list secrets,
  encrypted key packages, conflict resolution, UI and cache-at-rest
  encryption are separate tasks.
- An authenticated signed membership log can be withheld by a hostile
  server. Checkpoint pinning detects previously observed rollback or forks,
  not unseen later membership events.
- No external crypto/security reviewer has approved these formats.

## Tests

`test/v2-member-keys.test.mjs` checks non-extractable ECDH keypair
consistency and substituted/missing private keys.

The Chromium/Firefox `test/v2-storage.test.mjs` suite checks real IDB
round-trip, non-extractable private keys after DB reopen, refused
replacement, successful owner-signed member verification, trusted
checkpoint advancement, and revoked-member refusal.

The v1/Go/Raspberry Pi app and deployed Cloudflare configuration remain
unchanged.
