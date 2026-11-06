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
- Current stacked PR — Durable Object invitation registry: atomic first-use
  enrollment, in-transaction current-owner/epoch authorization and recipient
  proof-of-possession checks.

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
4. **Identity/authorization:** list-scoped member public keys and immutable
   signed role transitions; whether a recipient proof-of-possession plus a
   stolen QR permits any unauthorized downgrade, replay or role escalation.
5. **Epoch rotation:** revocation under offline edits and missing acknowledgements,
   how new epoch keys reach remaining members and how to prevent old-epoch
   writes from being silently accepted.
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
these adapters, the prototype fails closed. The membership ledger and
recipient challenge/receipt protocol have not been implemented.

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
