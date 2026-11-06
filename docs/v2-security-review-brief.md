# Panier v2 — independent security review brief

**Status: review requested as soon as an independent reviewer is available.**
This brief is intended for a security engineer with E2EE protocol and browser
cryptography experience. No production deployment or user secrets are needed.

## System and scope

Panier v2 is an anonymous, browser-based collaborative shopping-list application
with Cloudflare Durable Objects storing encrypted changes. There are no accounts
or central administrator recovery. The owner can enroll someone **in person,
using a QR code only**, with a proposed 10-minute invitation lifetime.
The recipient must authenticate independently. An optional encrypted owner
recovery kit and explicit owner transfer are product decisions, not implemented
cryptographic protocols.

**Code/design under review:**
- PR #12 — ADR-0001/0002 architecture and proposed threat/security gates.
- PR #13 — accepted-log deterministic reducer and tombstone semantics.
- PR #14 — IndexedDB accepted/optimistic/outbox transaction boundary.
- PR #15 — verified pull and sealed-upload sync coordinator.
- PR #16 — durable immutable encrypted outbox.
- PR #17 — ECDSA P-256 signing, HKDF and AES-256-GCM mutation envelopes.
- PR #19 — QR owner-prepared signed encrypted key package and token derivation.
- PR #20 — Durable Object invitation registry: atomic first-use
  enrollment, in-transaction current-owner/epoch authorization and recipient
  proof-of-possession checks.
- PR #21 — experimental owner-pinned, hash-linked membership ledger:
  signed genesis/rotations and QR grant plus recipient proof for joins;
  full-chain verification and ledger-backed registration gates.
- PR #22 — encrypted post-revocation key-envelope prototype: separate P-256
  ECDH identities, recipient-specific AES-GCM key wraps and signed epoch-head
  binding, plus explicit quarantine of stale offline mutations.
- PR #23 — QR enrollment v2 authenticates each recipient's separate ECDH
  agreement public key in the signed enrollment proof and membership ledger,
  and derives rekey recipients from the verified ledger rather than a
  server-supplied list.
- PR #24 — recipient-signed, secret-derived authenticated receipts proving
  the registered signing identity knows the newly decrypted epoch secret
  for an exact owner-signed key package and membership rotation head.

## Reviewer priorities

1. **Hostile server/key substitution:** owner signing-key fingerprint pinned
   into a physical QR; whether server-controlled membership lists, timestamps
   or actor keys can bypass an otherwise valid signature check.
2. **QR bearer exposure:** an adversary may photograph a QR and derive the
   *current epoch list key*, even after cancellation or successful redemption.
   Consumption prevents additional membership, **not decryption of a leaked
   package**. Is this product trade-off acceptable, or should the handshake
   use a different authenticated ephemeral-key exchange requiring owner presence?
3. **Single-use race/failure handling:** token commitment, concurrent attempts,
   atomic member registration, expiry and cancellation, retry after response
   loss, owner revocation and epoch changes between issuing and redeeming.
4. **Identity/authorization:** verify PR #21's owner-pinned genesis, signed
   rotation, and join events made from a signed invitation plus recipient
   proof. Challenge whether server-controlled ordering, withheld chain
   suffixes, unpinned heads, or a stale materialized membership cache can
   grant unauthorized writes or hide revocation. Check for cross-list replay,
   role escalation and canonical encoding inconsistencies.
5. **Epoch rotation:** examine PR #22's per-member ECDH envelopes and
   PR #23's **signed ECDH public-key binding**, key separation, replacement
   of v1 enrollment statements by v2, and PR #24's owner-verifiable
   confirmation receipts (signature plus secret-derived HMAC). Assess whether
   this actually demonstrates device access to the new key under the intended
   threat model: it is not unconditional proof of the ECDH private key.
   Review the race between signed rotation and key package publication,
   lack of durable/idempotent receipts and offline retained devices, and
   quarantine/rebasing of old-epoch edits after lost acknowledgements.
   Ensure old-epoch writes cannot be silently accepted.
6. **Owner recovery/transfer:** recovery-kit content, encryption, authority
   restoration, replay prevention, invalidation of previous owner kits, and
   recovery after device loss without granting server administrative recovery.
7. **Wire-format consistency:** canonical JSON ordering, ECDSA signature
   representation, AES-GCM nonce uniqueness/AAD, HKDF domains, key separation,
   cross-browser test vectors and downgrade resistance.
8. **Storage/browser threats:** non-extractable keys in IndexedDB, same-origin
   malicious JavaScript, plaintext optimistic cache, local data eviction,
   user-supplied crypto/IDB adapter behavior, CSP/supply chain controls.
9. **Backend abuse and availability:** rate limiting, invitation quota/garbage
   collection, persistent receipt semantics, per-list DO routing, clock and
   network manipulation, withheld data, stale snapshots.

## Explicit unresolved integration dependencies

The QR registry prototype has **no deployed endpoints or production bindings**.
Its `authOwner` callback must consult an authenticated list-owner credential,
and `authorizeEnrollment({tx,...})` must check the current signed owner
authority and epoch inside the same Durable Object transaction. Without
these adapters, the prototype fails closed. The **experimental** membership-ledger prototype is now in PR #21,
with `ledgerAuthorizers` callbacks, a pinned owner genesis and
transactional join evidence. However, authenticated production bootstrap,
server/client agreement on the latest membership head, signed ownership
transfer, production-level durable/idempotent receipt storage and atomic
key-epoch distribution are still absent. PR #24 now implements a
**client-side key-delivery receipt prototype**, but does not define server
receipt transport, retry/freshness rules or guarantees for offline recipients.
The separate QR-enrollment lost-response receipt protocol is still absent.

The implementation stores server-visible metadata and encrypted list-key
packages, never a QR seed or plaintext list key. It does not prove that a
QR was scanned in person. Signed cryptographic objects do not make Cloudflare
incapable of withholding data.

## Suggested review deliverables

- Written threat model covering server compromise, photographed QR,
  revoked devices, malicious members and offline divergence.
- Prioritized findings (critical/high/medium/low) with practical exploit
  scenarios and affected files.
- Protocol revision recommendations with signed-message formats and
  cross-browser test vectors.
- Explicit go/no-go decision for each of: invitation enrollment, epoch
  rotation, owner recovery, and encrypted offline sync.

**Do not review solely against green CI.** Unit tests do not establish
cryptographic correctness or security of the combined protocol. Do not ship
v2's E2EE implementation until the reviewer is satisfied with the security
invariants and production integration tests.
