# ADR-0001: Panier v2 collaboration architecture

Status: **Product decisions approved; cryptographic protocol remains proposed and requires review.**  
Tracks: [#2](https://github.com/pyrocklast/panier/issues/2)  
Scope: browser PWA and Cloudflare Worker only. The Go/Raspberry Pi implementation is **out of scope** for v2.

## Approved product decisions (2026-11-06)

The following are **decided**, not open design questions:

1. **Owner recovery = recovery kit + optional ownership transfer.** The list
   owner can export a locally generated, user-controlled encrypted recovery kit,
   and explicitly transfer the owner role to an active member. Neither a server
   administrator nor another member may silently assume ownership. A lost kit
   with no remaining authorised owner means loss of administrative control;
   no server-side account reset is promised. The exact recovery credential,
   transfer proof and lost-device workflow require a protocol specification.
2. **Invitations = link.** The owner creates a random, single-use, list-scoped
   invitation link. Joining does **not** require a separate approval screen.
   Unused invitations are revocable and may expire. Possession of the complete
   link grants the ability to redeem it before expiry; this is a bearer-capability
   security trade-off, not proof of the recipient's real-world identity. The
   recipient must receive a cryptographically authenticated key envelope; that
   handshake still requires review.
3. **Migration = explicit copy.** Users consciously copy a v1 list into a
   freshly generated independent v2 list. The source v1 list, `#k=` pairing
   links, browser data, and server log remain unchanged. There is no automatic
   in-place upgrade or ongoing bidirectional v1/v2 bridge. See the
   [migration plan](../v2-migration.md).

These choices are approved for the product. **They do not constitute approval
of the key-transfer protocol, revocation implementation or recovery cryptography.**

## Product contract

Panier is a small, multi-user shopping-list app. One anonymous browser installation
can create or join **multiple independent lists**. All list contents are end-to-end
encrypted. A user can read and edit their downloaded lists without a connection;
saved offline edits synchronise after reconnecting. No account, email, product
catalogue, or framework is required.

The existing v1 application stays usable while v2 is developed. No v1 client or
database is migrated in place until a tested migration/rollback path exists.

## High-level design

| Boundary | Responsibility | Does not do |
| --- | --- | --- |
| Browser UI (vanilla TypeScript, native HTML/CSS) | Shopping interactions; accessibility; list switching; member/recovery flows | Network or crypto implementation details |
| Browser domain module | Versioned item/section mutation format and **deterministic** reducer | Storage or transport |
| Browser crypto module (Web Crypto) | Identity keys; key envelopes; signatures; encryption; validation | Plaintext or keys on server |
| Browser IndexedDB | Installation identity; per-list metadata; local materialised state; immutable pending operations; last applied revision | Assume persistence is a backup |
| Browser sync coordinator | Push, pull, retry, rebase; tab coordination with Web Locks/BroadcastChannel | Rely on background sync for correctness |
| Cloudflare Worker | Request routing, rate/size limits, origin and API version checks | Inspect plaintext shopping data |
| One SQLite-backed Durable Object **per list** | Membership and permissions; invitations; ordered opaque operation log; unique mutation IDs; notification sockets | Decrypt list content; merge fields |
| Service Worker | Offline app shell and update lifecycle | Cache API secrets or own authoritative sync state |

The **Durable Object** serialises each list's accepted operations and assigns
monotonic revisions. The **clients**, not the server, evaluate encrypted
shopping-list mutations. WebSocket notifications are hints; clients always
reconcile using revision-based HTTPS pull.

A browser installation is **not** a person. An installation can hold multiple
list memberships, and one person using a phone and a laptop has two installations.
Membership and authorization are **per list**. The server may learn that two
members access the same list, but not what they buy.

## State and identifiers

- **Installation:** random installation ID, proof-of-possession signing key,
  and key-agreement key, stored locally. Prefer non-extractable private keys where
  browser support and recovery requirements allow. Never use the display name as
  identity.
- **List:** random opaque list ID, protocol version, independent key epochs,
  ordered operation revisions, members, invitations and ciphertext.
- **Membership:** random member ID scoped to one list, a registered public
  signing key, key-envelope recipient key, role (owner/member) and state
  (active/revoked). Server verifies the permission for **every** request.
- **Item/section:** stable random IDs. Item text, section text, quantities,
  checked state, ordering and list title are inside encrypted application data.
  Duplicate item names are valid.
- **Operation:** unique random mutation ID, member/actor ID, key epoch, format
  version, encrypted payload, authenticated metadata and signature. A unique
  (list ID, mutation ID) constraint makes retries idempotent.

Schema and wire formats must be versioned and size-bounded. Membership and log
metadata are *not* E2EE; never represent them as hidden from the service.

## Identity and authentication

Use a proof-of-possession protocol, not the v1 single shared bearer token.
The recommended starting point is browser-supported P-256 ECDSA for member
signatures and P-256 ECDH for key envelopes, with separate keys for separate
purposes. Review exact browser compatibility and chosen serialization before
fixing the wire protocol.

Every sensitive request binds the signed data to method, path, list, member,
operation ID or nonce, protocol version, and a bounded challenge/expiry as
appropriate. Replay prevention belongs on the server. Granting a membership
registers that member's public keys. The owner may revoke **that membership**
without affecting others. A list creator becomes the initial owner. A separate
owner-recovery or ownership-transfer policy is required before shipping revocation;
otherwise an owner losing a device can permanently strand the list.

An anonymous identity cannot reliably identify a *human*. Device labels are
optional local-friendly names, not security claims.

**Owner transfer policy (approved at product level):** the current owner may
explicitly designate an active member as replacement owner. The transfer must
be authenticated by the current owner's signing credential, committed atomically
with the role change and reflected in an append-only audit record. A stale owner
credential, replayed transfer or unapproved member must not be able to appoint
an owner. Whether to permit more than one owner and how recovery credentials
authorize a replacement key are **still technical review gates**. Avoid assuming
the server's role table alone protects E2EE if compromised.

## E2EE key lifecycle

Each list has an independently random 256-bit content secret for its current
**epoch**. Derive context-separated operation-encryption keys using HKDF-SHA-256.
Use AES-256-GCM with fresh 96-bit nonces, unique per encryption under the same
key. Authenticated additional data **must** bind protocol version, opaque list
ID, epoch, mutation ID, and other public operation fields to their ciphertext.
Canonical encoding must be fixed before signatures are implemented.

New members receive a key envelope encrypted to their registered key-agreement
public key. Use an ephemeral ECDH key, HKDF with domain separation and random
AES-GCM nonce (or a reviewed equivalent). An envelope includes the list/epoch,
recipient and sender identity, and authentication of the issuer. Client-side
verification is required; do not silently accept unauthenticated envelopes.
Private key material and plaintext list keys never enter server APIs.

**Invitation (approved UX):** an owner creates a cryptographically random,
list-scoped, **single-use link**; unused links can be revoked and may expire.
No separate owner approval is required once the link is issued. Redemption atomically
consumes it and registers a recipient public key. An invitation URL can carry
client-only secret material in its fragment, which is not sent with an HTTP
request. However, **the whole URL is a bearer secret** and can leak through
messaging, screenshots, browser history or malicious app code. Clear fragments
after parsing, redact logs and protect against replay and simultaneous redemption.
The final enrollment handshake must specify how the owner authenticates the
recipient's public key and how that recipient obtains the correct envelope;
**do not implement an unauthenticated key swap**.

**Revocation:** refuse the revoked member's API access, commit a new key epoch,
and send recipient-specific key envelopes to remaining members. All new writes
are fenced to the new epoch. Rotation must define behavior for an offline member,
an interrupted key distribution, and old-epoch pending edits. The client must
never silently discard those edits. A revoked participant can retain data and
keys they previously downloaded. E2EE does not erase past knowledge.

**Important distinction:** the server can validate authorized signatures and
epochs but cannot determine whether an encrypted item operation is meaningful
or valid. The clients verify signatures, decrypt and validate mutation schemas.

## Offline synchronisation and conflict rules

1. Persist the user action, optimistic result, and uniquely identified outbox
   mutation in **one IndexedDB transaction**. Only then report "saved locally".
2. When connected, authenticate and upload pending operations. Server verifies
   membership, signature, epoch and request limits; atomically stores each new
   mutation with a monotonically increasing revision. Retry of the same mutation
   ID returns the original result.
3. Pull all revisions after the client's last *durably applied* revision; verify,
   decrypt and apply in order with the pure reducer. Advance the cursor in the
   same IndexedDB transaction as the state update.
4. Rebase optimistic pending edits over the newly accepted remote history,
   including conflicting field changes and deletes.
5. Acknowledge only when the server response is confirmed and durable local
   queue state has been updated. Handle lost responses by idempotent retry.
6. Coordinate tabs using a single local writer where possible and cross-tab
   change notification; **do not** replace an entire state snapshot from a
   storage event.

Do not use wall-clock times to declare which offline edit happened last.
The server's accepted revision order is the deterministic ordering. Operation
semantics must be specified **per operation** (not as a blanket timestamp LWW):
independent additions survive; concurrent scalar edits resolve by accepted order;
deletion uses tombstones; edits to deleted items, undo, section deletion and
reordering need explicit tests. A simpler reducer is preferable to a CRDT until
real requirements justify the complexity.

The service can delay or omit operations. Revision checks make accidental gaps
detectable; E2EE alone **cannot guarantee freshness or availability** against a
malicious server. Snapshot pruning requires explicit authenticated checkpoints
and a verified recovery procedure before deleting history.

## Browser persistence and recovery

IndexedDB is a cache **and a durable local outbox**, not a backup guarantee.
Handle storage-denied, quota, corrupted data, failed migrations, concurrent tabs
and device loss as user-visible states. Request persistent storage where supported
but do not assume approval. A decrypted local list cache is accessible to code
running in the app origin and potentially to someone with access to the device.
Document this limit.

**Owner recovery choice:** provide a recovery kit and allow explicit ownership
transfer. The kit must carry enough encrypted information to recover both
list decryption and authorised owner access without relying on an old browser
installation; a bare backup of the list key is insufficient. A stolen kit
may confer powerful access, so require a reviewed encryption/authentication
and recovery-credential invalidation strategy. Ownership transfer must not
leave the former owner with irrevocable administrative authority.

For anonymous E2EE, credentials and the content key are both required to regain
access. Provide an explicit encrypted recovery bundle (and safe offline backup
instructions) or an independently specified re-enrollment path through a trusted
remaining owner. Do not claim ordinary account-style "password reset" recovery.
The recovery export must authenticate its contents, use a user-controlled secret
if password-encrypted, and define how leaked backups are revoked or superseded.

## UX constraints

Default to the active shopping list, not a settings dashboard. Keep fast inline
entry, one-tap checking, optional sections, keyboard operation, and an accessible
alternative to drag-and-drop. Provide a small list switcher, invite/members
view, and minimal appearance/data/about settings. Distinguish:

- **Saved locally** — transaction committed to local storage.
- **Waiting to sync** — encrypted operations pending remote acknowledgement.
- **Synced** — all accepted operations through the known remote cursor applied.
- **Unable to save** — user action could not be committed locally.

A WebSocket connection is not proof of synchronisation.

## Threat model and explicit non-goals

| Threat / failure | Intended mitigation | Residual limitation |
| --- | --- | --- |
| Network interception | TLS, authenticated E2EE and signed operations | Traffic metadata remains visible |
| Server inspects database | Encrypted payloads and encrypted snapshots | List/member IDs, IPs, timing and sizes remain visible |
| Unauthorized writes or replays | Member signatures, authorization, nonce/challenge/ID checking | Compromised member can write as itself |
| Malicious server drops/reorders data | Signed mutations, revision checks, authenticated snapshots | Availability and freshness cannot be fully guaranteed |
| Stolen invitation | Short-lived single-use grant, revocation, client-side key handling | Holder can join before legitimate recipient |
| Revoked member | Server access denial and future-epoch key rotation | Previous keys and previously read contents remain exposed |
| Device/browser storage lost | Recovery export, trusted member re-invitation | Total loss of all keys/backups is unrecoverable |
| Modified client JavaScript or compromised deploy | Protected deployment, pinned actions, scoped credentials, 2FA | Same-origin malicious JS can access plaintext and key operations |
| Local device compromise | Device lock and careful local key handling | Browser-local plaintext cache can be exposed |
| Quota/network failures | Limits, idempotent retry, explicit persistence/sync errors | Service can still become unavailable |

No account system, centralized person identity, server-side plaintext search,
product catalogue, recipes, prices, analytics, custom permissions framework,
generic distributed database or required background synchronization.

## Decision gates / unresolved protocol details

**Approved:** recovery kit + explicit ownership transfer, single-use invitation
links without approval, and opt-in v1 → v2 **copy** (no in-place migration).

**Still blocking security-sensitive implementation / approval:**

1. **Key recovery and ownership-transfer protocol:** key material in encrypted
   recovery kit, secret strength, recovery credential revocation, authenticated
   role transfer, lost-owner behavior and tests.
2. **Invitation enrollment handshake:** authenticating ephemeral/recipient
   public keys, ensuring single-use atomic redemption, preventing envelope
   substitution, confirming what link theft permits and cross-browser tests.
3. **Key epoch rotation:** atomic membership/rekey boundaries, recovering
   remaining offline members, conflict handling for queued old-epoch writes,
   split-brain/rollback avoidance and explicit treatment of revoked devices.
4. **Wire format:** exact versioned canonical encoding, authenticated metadata,
   signatures, key-envelope algorithm and nonce/key separation. Browser
   compatibility and independent security review before production.
5. **Retention and recovery:** log size limits, encrypted authenticated
   checkpoints, quota behavior, compaction safety and restore/integrity tests.

The [approved-decision and security review record](./0002-v2-product-decisions.md)
details the approved UX contract and protocol acceptance gates. The
[v1-to-v2 migration plan](../v2-migration.md) now records the **approved copy**
policy; implementation and rollout still require tests.

## Implementation order

- **Phase 0:** this ADR, migration plan, threat model and executable protocol
  test vectors. No production data changes.
- **Phase 1:** domain reducer and IndexedDB local persistence; failures observable.
- **Phase 2:** per-list membership, invitation and epoch protocol prototype on
  the real Cloudflare runtime; security tests.
- **Phase 3:** ordered idempotent sync, offline reconnect and multi-tab tests.
- **Phase 4:** multi-list UI, accessible sharing/recovery and complete migration.
- **Phase 5:** production Cloudflare CI, failure-injection and gated rollout.

Related issues: #3 (IndexedDB), #4 (identity), #5 (invitations),
#6 (key epochs), #7 (backend), #8 (reducer), #9 (sync), #10 (UI), #11 (tests).

## Why not reuse the v1 protocol?

V1 derives its list ID, bearer authorization token and encryption key from one
shared 256-bit secret; anyone with the pairing link has equivalent access. Its
single-list state and outbox are persisted as one `localStorage["panier"]` value
and storage write errors are ignored. This is coherent for v1's two-phone use
case, but does not provide independently revocable members, multiple isolated
lists or atomic persistence. V2 needs a **versioned and explicitly distinct**
protocol, not a silent reinterpretation of existing v1 tokens.
