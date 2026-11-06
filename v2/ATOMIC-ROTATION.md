# Panier v2 — atomic membership epoch publication

**Experimental Durable Object-compatible core, not deployed or production
ready. No v1 Worker, Wrangler, PWA, or Raspberry Pi/Go code is changed.**

## Security invariant

After a member is revoked, the server must not expose a new membership
epoch without also storing the correctly encrypted new epoch secret for
**every active surviving recipient**. An offline recipient needs to retrieve
their specific wrapped key when they reconnect, without requiring the owner
to remain online. The **rotation head** is preserved as a separate epoch
fence even if a later QR join advances the current membership-chain head.

`v2/atomic-rotation.mjs` provides `publishAtomicRotation(storage,
{event,envelopes})` for a *single list's* Durable Object storage namespace.

The owner prepares, **before** the storage transaction:

1. A locally fresh 32-byte secret for epoch N+1, never submitted in plaintext.
2. The signed rotation event (PR #21), referencing the current signed
   membership head and revoking one specific member.
3. The deterministic future hash of the **already signed** rotation event,
   computed using `previewSignedRotation` against the locally verified,
   pinned current membership state. This is not a server-supplied head.
4. A separate AES-256-GCM / ephemeral ECDH package for **each active,
   non-owner, surviving member**, bound to that predicted head, recipient
   ID, epoch and the member's authenticated ECDH public key. Every package
   is signed by the owner (PRs #22 and #23).

The server re-verifies the signed rotation, current sequence/head, *complete*
recipient set, each ECDH key binding and package signature inside **one
Durable Object storage transaction**. It then commits together:

- the signed rotation event and updated membership state;
- every recipient's encrypted key package, keyed by epoch + recipient ID;
- an immutable publication manifest keyed by signed rotation head;
- the current-epoch append fence.

The transaction rejects missing, duplicate, substituted, forged or surplus
packages, stale epoch/head, and concurrent competing rotations. Aborted
transactions leave all state unchanged. An owner-only list may publish zero
recipient packages, because the owner itself generates the new secret.

**Wire-format change:** the experimental rekey package is now version 2.
The owner-signed envelope and its authenticated encryption metadata include
the recipient's registered ECDH public key, allowing the Durable Object to
validate that the sealed package targets the correct signed member identity
**without possessing or decrypting the new list secret**. Version-1
experimental rekey packages cannot be used with atomic publication.

## Access and append contracts

`readCurrentKeyPackage(storage,{listId,memberId})` allows a returning
active recipient to fetch the current epoch ciphertext and manifest.
A later membership join in the same epoch does **not** invalidate the
earlier rotation's encryption envelopes. The epoch fence retains the
original rotation head and sequence while membership events extend the
hash-linked chain.
It requires its caller to **authenticate the recipient** separately; passing
a claimed member ID from an unauthenticated HTTP request would be insecure.

`assertCurrentEpochAppend(tx,{listId,memberId,epoch})` checks the current
membership epoch, active member and publication fence. The future mutation
append handler MUST call it **in the same transaction** as accepted-log
append, and MUST additionally authenticate the full member signature,
mutation identity, list binding and ciphertext. This module does not add
that handler or any deployed Worker route.

The older `rotateLedger` bare-rotation prototype now rejects normal calls:
its `{testOnlyUnsafe:true}` escape hatch exists solely for legacy unit-test
fixtures and **must never be wired into a Worker endpoint**.

## What this DOES NOT establish

- **Freshness/fork detection**: the server could still withhold signed
  membership events, rotation packages or a newer head. Clients must pin
  their last verified head and verify chain extension, and a threat model
  for equivocation must be independently reviewed.
- **Owner secret equality**: the server verifies every encrypted package's
  signature and recipient key, but cannot prove that the owner encrypted
  the *same* secret for all recipients without a dedicated protocol. The
  user-facing receipt in PR #24 permits owners to validate confirmations
  against the locally generated intended secret.
- **Delivery confirmation**: publication means the ciphertext is stored,
  NOT that offline devices received/decrypted it. Signed key-confirmation
  receipts exist in PR #24, but are not durably stored/idempotently retried.
- **Offline old-epoch writes**: the append-fencing helper rejects them, but
  a reviewed local reconciliation/rebase flow still needs to assign new
  mutation IDs and preserve the original signed outbox records.
- **Multiple rotations while offline**: current-epoch packages can be read
  when a member reconnects, but the full key-history/snapshot retention
  policy and audit trail are not specified.
- **Abuse handling**: quotas, authorization of HTTP requests, rate limiting,
  object lifecycle, actual Cloudflare worker routing and real DO integration
  tests are still missing.
- **Owner transfer/recovery** and independent security review are still
  hard gates. Rotation cannot retroactively erase old list keys from a
  previously authorized or QR-compromised device.

## Tests

`node --test test/v2-atomic-rotation.test.mjs` covers complete publication,
concurrent competing rotations, rollback on a faulted final fence write,
package signature/recipient substitution, missing or duplicate packages,
offline retrieval **even after a later join in the same epoch**, owner-only
rotation, replay, old/future-epoch mutation fences, and revoked-member access.

It uses a serializing transaction/rollback mock, **not a deployed Durable
Object**. CI also runs the older v2 Web Crypto and Chromium/Firefox suites.
Unit tests cannot replace the requested independent protocol review.
