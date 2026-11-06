# Panier v2 encrypted mutation prototype

**Draft cryptographic foundation; not an approved security protocol and not
connected to production.** Tracks issues #4, #6 and security gate S4 of PR #12.

This module deliberately addresses a small part of the problem: authenticated
encryption of **one mutation** and verification against a **trusted list-scoped
member public key**. It does not issue membership, handle QR invitations, rotate
keys, restore an owner, or decide whether a revoked member may upload a queued
operation. Those decisions must be specified and independently reviewed.

## Chosen prototype suite (subject to security review)

- Installation/member signing identity: Web Crypto **ECDSA P-256 / SHA-256**.
  The private key is generated **non-extractable**; the public JWK may be
  published only through an authenticated list-membership registration.
  The `actorId` generated here is a local random identifier, **not** proof of
  membership or a stable real-world person.
- Each list/epoch starts from a separate, randomly generated 32-byte content
  secret supplied by a future key-management component. HKDF-SHA-256 derives
  an AES-256-GCM mutation key from the raw secret, with salt bound to list ID
  and `info` bound to mutation purpose and key epoch.
- Each **new** encrypted mutation generates a random 96-bit GCM nonce.
  This depends on securely generated randomness; nonce uniqueness is
  probabilistic. Never reuse the exact nonce/key pair for distinct plaintext.
  **Retries reuse the same already-encrypted envelope** via PR #16.
- AAD binds `{v,listId,id,epoch,actorId}` to the ciphertext.
  Signature covers that metadata, nonce and ciphertext using the specified
  ordered JSON bytes. The server later assigns the accepted revision,
  which is deliberately **not** covered by the client signature.
- The `ciphertext` field in the existing durable outbox contains a base64url
  encoding of this *complete* signed envelope, not just AES ciphertext.
  The field name is historical and the inner metadata remains visible to
  the service. Item text, quantities and section content stay encrypted.
- The current encoded envelope must fit the 24-KiB string bound imposed by
  the storage prototype. Inputs are bounded and malformed/noncanonical
  encodings fail closed. This encoding is **experimental** and must be
  versioned before deployment.

## Trust boundary

`openMutation` takes two callbacks:
`resolveMember({listId,actorId,epoch})` must return a public CryptoKey that
was securely bound to that member and list/epoch, or null if unauthorized;
`resolveListSecret({listId,epoch})` returns the 32-byte list secret when
available. Neither callback is implemented here.

**Never resolve the signing key from a value embedded in the operation** or
accept a server-provided public key as authoritative without member proof.
Possessing a list key alone is not permission to write. The server also has
to enforce membership/epoch authorization on append. A malicious server can
withhold data and lie about freshness; signatures do not solve availability.

An example usage with the already existing IndexedDB API:

```js
const identity = await generateSigningIdentity();
const sealed = await sealMutation({
  draft, actorId: membership.actorId, epoch: membership.epoch,
  privateKey: identity.privateKey, listSecret: currentListSecret,
});
await commitSealedLocalMutation(db, draft, sealed);
// Only now may the UI say "saved locally".
```

The `createSyncSecurity` adapter bridges the existing sync coordinator's
`decodeAndVerify` and `loadSealed` slots, given trusted membership/epoch
lookups and `loadSealedMutation` from IndexedDB. No fetch, crypto key
storage or network pairing is introduced.

## Required follow-up before production

1. **Identity persistence:** non-extractable CryptoKeys are structured-clonable
   into IndexedDB in supported browsers but identity lifecycle, restoration
   across browsers, and recovery kit authority are not implemented here.
2. **Membership and QR:** complete the in-person single-use QR/key-envelope
   handshake, recipient public-key registration and authentic owner binding.
3. **Epoch revocation:** an offline pending write sealed for an old epoch
   cannot automatically be accepted after revocation; add a reviewed
   reconciliation/re-encryption policy.
4. **Wire security:** cross-browser test vectors, hostile-server/replay tests,
   immutable server mutation ID binding, signed canonical formats and a
   security reviewer. ECDSA signing randomness and AES-GCM nonce randomness
   mean ciphertext snapshots will differ across fresh encryptions.
5. **Local plaintext:** optimistic list state and outbox payloads are still
   present in IndexedDB in plaintext. E2EE protects against server reads,
   not compromised app origin or device access.
6. **Deployment:** no protocol is production-ready until the owner recovery
   and invite model in PR #12 is resolved.

## Tests

Run `node --test test/v2-crypto.test.mjs` on Node 22; CI includes this
suite alongside the reducer, sync coordinator and browser persistence suites.
Tests cover non-extractable identities, round-trip crypto, tamper/wrong-list
detection, wrong signer/epoch secret, rejected unauthorized members,
noncanonical envelopes, and durable-outbox adapter contracts.

**Raspberry Pi / Go and v1 PWA are out of scope.**
