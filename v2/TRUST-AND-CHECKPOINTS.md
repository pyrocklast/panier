# Panier v2 — owner bootstrap and local membership checkpoints

**Draft security prototype. No production PWA, Worker, Wrangler or deployment changes.**
See draft PR #27 and the independent security review in `docs/v2-security-review-brief.md`.

## Who authenticates the initial owner key?

Cloudflare cannot decide who the real owner is: a self-signed genesis alone
only proves that *some key* signed it. Accepting the first key downloaded from
Cloudflare would let a malicious or compromised server replace the owner.

Two explicit, auditable client flows are supported in `v2/trust.mjs`:

**Owner device:** generate an anonymous P-256 ECDSA signing identity with a
non-extractable private CryptoKey. Call `pinNewOwnerBeforeBootstrap` with
the locally generated identity. It signs a genesis event, immediately verifies
that event against the *locally generated* public key, and stores the key,
owner identity and signed genesis hash in the dedicated
`panier-v2-trust` IndexedDB database. **Only after the transaction
successfully commits** may the caller POST the signed genesis to the v2 API.
If the network fails, preserve the locally pinned root and retry/reconcile
with a verified history; never replace it with a server-provided key.
The original **signed genesis bytes** and genesis hash are persisted
alongside the non-extractable signing key. Use
`readPinnedOwnerGenesis(db,listId)` to retry the EXACT event after an
uncertain response: re-signing with ECDSA may produce different bytes and
therefore a different genesis checkpoint hash. The isolated Cloudflare
bootstrap endpoint accepts byte-identical genesis retries idempotently,
but rejects conflicting owner keys, signatures or genesis events.
After receiving a bootstrap response, fetch authenticated membership history
and advance the pinned checkpoint; the response alone is not a trust proof.

**In-person recipient:** scan the owner's physical QR. The QR contains an
owner public-key fingerprint, a random encryption-capability seed and
invitation context. `pinOwnerFromScannedQr` verifies the owner-signed
encrypted invitation via `openQrKeyPackage`, extracts the QR-authenticated
owner key, verifies the complete signed membership history against that
key and requires matching list ID, owner ID and key epoch. Only then does
it persist a trusted root/checkpoint. The QR-derived decryption secret is
returned to the enrollment caller, **never saved in the trust store**.

Do not offer a remote/link/QR-export fallback. A photographed QR is still a
bearer secret, not proof of proximity. Do not accept a history root on first
connection without either local owner creation or QR verification.

## Rollback and equivocation detection

After trust is pinned, callers MUST use `advancePinnedMembership` to
verify/advance their checkpoint before treating server membership state or
its current epoch as authoritative. The operation:

1. Reads an existing pinned root. Unknown lists **fail closed**.
2. Verifies the *whole* hash-linked, signature-authenticated history using
   `verifyMembershipHistory(events,pinnedOwnerPublicJwk)`.
3. Requires the returned list/owner identity to match the pinned root.
4. Requires history to reach at least the saved sequence and have the
   exact saved event hash at that sequence. This rejects missing prefixes,
   rolled-back history, same-sequence signed forks and alternate genesis.
5. Computes all event hashes *before* opening an IndexedDB read/write
   transaction; under the transaction it rechecks whichever newer
   checkpoint another browser tab may have committed and updates only if
   the proposed history extends it. Commit completes before returning.

Checkpoints retain only `{sequence,head,epoch}` plus the independent owner
public key, owner ID and provenance. A non-extractable owner CryptoKey may
also be stored; `readPinnedTrust` intentionally returns only public
checkpoint data. `readLocalOwnerSigningKey` is restricted to
`source: "owner-local"`. Browser tab concurrency does not permit a fork
or a shorter history to replace the previous checkpoint.

## Limits — still critical

- **No global freshness guarantee.** The server may withhold *newer, unseen*
  signed events forever. A client can only reject changes inconsistent
  with what that device already observed and pinned.
- **No automatic cross-device anti-equivocation.** Different devices may
  initially accept different valid signed branches. Authenticated
  checkpoint comparison/gossip, transparency or some other audited
  consistency protocol is needed before the hostile-server threat gate is
  complete. Stronger guarantees may be impossible with this trust model
  without an external witness.
- **First-write denial-of-service remains possible.** Cloudflare may accept
  an attacker's self-signed genesis for a guessed/compromised list ID
  before the real owner. Locally pinned identity makes this a detectable
  bootstrap conflict, **not** a silently accepted new owner. The server
  cannot independently authenticate which genesis should win.
- **Storage loss requires real recovery.** If IndexedDB is evicted, cleared
  or moved to another device, do NOT trust Cloudflare's first supplied key.
  Require a reviewed local encrypted recovery kit or another physical
  owner-authorized pairing. Neither is implemented here.
- **Same-origin malicious JavaScript defeats this local trust store.**
  Non-extractable CryptoKeys protect against accidental raw private-key
  export, not against XSS or a malicious Worker-served PWA that can invoke
  Web Crypto or corrupt stored checkpoints.
- **No deployed client integration.** Trust helpers have explicit call
  boundaries and isolated browser/Node tests; there is no shipped PWA
  gating `syncOnce` yet. The Cloudflare API still returns untrusted history
  bytes. Clients must pin/verify before using them.
- **Signature/wire canonicalization is experimental.** A security reviewer
  should assess consistent hash serialization, replay protections and
  bootstrapping under hostile origins before enabling production E2EE.

## Test coverage

`node --test test/v2-trust.test.mjs` covers owner-root verification,
server history rollback, valid competing signed forks, substituted genesis
and wrong list/owner identities.

`test/v2-storage.test.mjs` adds real Chromium and Firefox tests for
non-extractable owner key persistence across database reopen, explicit
QR-only recipient trust pinning, refusal to replace trust, and concurrent
tabs presenting different valid signed histories.

The existing local Wrangler DO test also checks membership history
received from Cloudflare against a previously selected owner root.
**Green tests are not a substitute for external security review.**
