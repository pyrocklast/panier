# Panier v2 — durable but unverified key-delivery receipts

**Draft, isolated Cloudflare Durable Object prototype. No production route,
deployment, PWA integration, owner recovery or independent security audit.**
This change is stacked on the bounded API work in PR #29.

## The crucial trust boundary

A member who decrypts an owner-signed new-epoch key package can sign a
receipt that also contains a secret-derived HMAC. **Cloudflare does not know
the epoch secret**, and therefore must never report that this HMAC is valid.

`v2/rekey-receipt-store.mjs` separates two things:

1. **Stored:** the server verifies the recipient's signature using the
   currently authenticated membership ledger, checks current epoch, signed
   rotation head, recipient ID, and SHA-256 of the *exact* published
   ciphertext package. It stores the complete receipt in a durable DO
   transaction and returns `stored:true,verifiedByOwner:false`.
2. **Owner-confirmed:** the owner fetches the stored receipt through its
   own signed API request and locally calls `verifyRekeyReceipt` (from
   PR #24) using the previously verified signed rotation checkpoint,
   exact ciphertext and **locally generated new epoch secret**. Only the
   owner can verify the HMAC and conclude knowledge of the right secret.

The member endpoint is
`POST /v2/lists/:listId/rekey-receipt` with a member-signed outer API
request and body `{listId,receipt}`. The owner-only query endpoint is
`POST /v2/lists/:listId/rekey-receipts` with a signed owner request and
`{listId}` body.

## Durable retry contract

- Receipt storage keys are `rekey:receipt:epoch:memberId`, scoped by the
  Durable Object's list ID.
- An exact receipt retry, or a fresh valid ECDSA signature over the same
  canonical signed transcript and HMAC, returns `duplicate:true` without
  overwriting stored evidence. Outer signed HTTP requests MUST use a new
  random nonce every time (the API's old nonce cannot be replayed).
- A conflicting transcript for the same member and epoch is refused
  rather than silently replacing the old proof.
- Owner retrieval returns all receipts for the **current published epoch**
  without claiming that any are cryptographically confirmed.
- If a recipient is offline, its slot simply has no receipt. Key package
  publication and offline recovery remain functional; the owner is not
  blocked waiting for a receipt.

## What remains unresolved

- A member can deliberately sign an invalid HMAC. The server will store
  that validly signed but **unconfirmed** claim. The owner rejects it;
  the current first-write-wins receipt store does not provide a recovery
  workflow for replacing an erroneous but signed claim.
- The current owner query only shows receipts for the current epoch; no
  reviewed archival receipt-retention, snapshot or multi-rotation policy.
- There is no cryptographic proof that all devices obtained *identical*
  secrets until the owner verifies all surviving members' HMAC receipts.
  Some may remain offline indefinitely, and the product must choose how
  to display prepared/published/received/owner-confirmed statuses.
- A signed receipt proves knowledge of the epoch secret under the
  authenticated member signing identity, not an unconditional ECDH
  private-key possession proof if that secret leaked by another channel.
- Clients must still pin the owner's original genesis and independently
  verify the signed membership history. Cloudflare may withhold/fork history,
  and local checkpoints only detect previously seen contradictions.
- The outer API still lacks global abuse controls, cryptographically
  auditable accepted-log authorization ordering, owner recovery, offline
  mutation rebase and a production-secure browser entrypoint.
- Returning `stored:true` to the UI must never be labeled "delivered",
  "confirmed", or "secured" until local owner verification has succeeded.

## Tests

`node --test test/v2-rekey-receipt-store.test.mjs` tests verified member
receipt forwarding, concurrent idempotent storage, wrong signatures,
package/head mismatch and owner-only HMAC knowledge verification.

The real local Wrangler DO integration test now signs and submits a receipt
after a membership rotation, retries it with a new outer request, retrieves
it as owner, locally verifies its HMAC and rejects an altered proof.

The production Panier v1 Worker, PWA and Raspberry Pi/Go implementation
remain untouched.
