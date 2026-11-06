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
- PR #25 — atomic signed epoch publication with full recipient coverage,
  authenticated rekey envelope version 2 (signed recipient agreement-key
  binding), persistent offline-retrievable packages and same-transaction
  append-epoch fencing.
- PR #26 — **separate locally runnable Cloudflare Worker/Durable Object API**:
  member-signed requests and durable nonce replay protection, authenticated
  invitation/redeem, signed membership history, atomic rekey and recipient
  retrieval, opaque signed mutation append with epoch fence and pull.
  First real Wrangler local-runtime integration tests.
- PR #27 — local owner-before-network genesis pinning; independent owner root
  binding from verified in-person QR on recipient devices; non-extractable
  signing key persistence and race-safe IndexedDB membership checkpoints
  rejecting any observed signed fork, shorter history or substituted root.
- PR #28 — trust-gated encrypted browser sync using pinned membership
  checkpoints before/after pull, signed authenticated API calls, and
  fail-closed quarantine of stale-epoch sealed outbox entries.
- PR #29 — bounded signed nonce replay state, list/member request budgets,
  and a transactional cap of five active QR invitations in the isolated DO.
- PR #30 — durable member-signed key-delivery receipts and owner-only
  retrieval. The server validates member identity/package binding but
  explicitly cannot validate secret-derived HMAC confirmations.

## Reviewer priorities

1. **Hostile server/key substitution:** review PR #27's local owner genesis
   pinning before first request and recipient root pinning from the physical
   QR, along with what happens if an adversary wins the server's initial
   first-write race. Confirm the protocol never silently trusts a server
   genesis, and that locally persisted anchors cannot be overwritten by
   a competing key. Evaluate browser storage loss and recovery handling.
2. **QR bearer exposure:** an adversary may photograph a QR and derive the
   *current epoch list key*, even after cancellation or successful redemption.
   Consumption prevents additional membership, **not decryption of a leaked
   package**. Is this product trade-off acceptable, or should the handshake
   use a different authenticated ephemeral-key exchange requiring owner presence?
3. **Single-use race/failure handling:** token commitment, concurrent attempts,
   atomic member registration, expiry and cancellation, retry after response
   loss, owner revocation and epoch changes between issuing and redeeming.
4. **Identity/authorization and rollback:** review PR #21's signed
   genesis/join/rotation records and PR #27's **persisted checkpoint
   extension rule**, including two-tab races, valid signed same-sequence
   forks, offline recovery and contradictory histories shown to separate
   devices. A pinned head detects only observed rollback/forks; server
   withholding of a newer unseen suffix is still possible. What authenticated
   cross-device checkpoint sharing/transparency design is necessary to
   detect server equivocation? Also review cross-list replay, role escalation,
   old-epoch writes and canonical serialization.
5. **Epoch rotation:** examine PR #22's per-member ECDH envelopes and
   PR #23's **signed ECDH public-key binding**, key separation, replacement
   of v1 enrollment statements by v2, and PR #24's owner-verifiable
   confirmation receipts (signature plus secret-derived HMAC). Assess whether
   this actually demonstrates device access to the new key under the intended
   threat model: it is not unconditional proof of the ECDH private key.
   Review PR #25's atomic rotation + complete package publication and
   membership-head prediction, including missing/forged recipient packages,
   concurrent rotations, epoch fences and recipient access after later joins.
   Review the still-missing durable/idempotent receipts, verified append
   authorization, offline key history and quarantine/rebasing of old-epoch
   edits after lost acknowledgements.
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
9. **Backend abuse and availability:** inspect the actual DO routes in
   PR #26, request-signature and accepted-mutation validation, and PR #29's
   bounded six-slot nonce replay ring, list/member rate budgets and five
   active invitation cap. PR #30 adds durable receipt forwarding, but
   Cloudflare cannot verify the secret-derived HMAC or claim delivery
   confirmed. Evaluate race conditions, idempotent response loss, stale
   epochs, clock manipulation and long-term durable metadata retention.
   **Still missing:** global WAF protections against random-list DO creation,
   cryptographically auditable accepted-log authorization ordering,
   invitation-history compaction, owner recovery, server withholding/forks,
   and security controls for a deployed PWA origin.

## Explicit unresolved integration dependencies

The QR registry prototype has **no deployed endpoints or production bindings**.
Its `authOwner` callback must consult an authenticated list-owner credential,
and `authorizeEnrollment({tx,...})` must check the current signed owner
authority and epoch inside the same Durable Object transaction. Without
these adapters, the prototype fails closed. The **experimental** membership-ledger prototype is now in PR #21,
with `ledgerAuthorizers` callbacks, a pinned owner genesis and
transactional join evidence. However, authenticated production bootstrap,
server/client agreement on the latest membership head, signed ownership
transfer and production-level durable/idempotent receipt storage
remain absent. PR #24 implements a **client-side key-delivery receipt
prototype**, without transport, retry/freshness rules or delivery assurance.
PR #25 implements **transaction-level key-epoch publication**.
PR #26 now connects it to an isolated **real local Cloudflare Durable Object**
with signed HTTP authorization and encrypted mutation append/pull.
This is **not** connected to the deployed Worker and does not establish
trusted genesis bootstrap, client-pinned server freshness, durable receipts,
owner recovery or production traffic/abuse protections.
The separate QR-enrollment lost-response receipt protocol is still absent.

PR #27 adds a **client-side** IndexedDB trust-anchor store and
monotonic membership checkpoints. PR #28 connects those checks to an
**isolated, unshipped** browser sync coordinator and signed API transport:
cryptographic membership refusals and stale key epochs stop upload while
preserving immutable queued edits. Locally saved roots and checkpoint comparisons cannot prove freshness
beyond the last observed authenticated state, and private-browser-data
eviction requires trusted recovery, not server-side TOFU.

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
