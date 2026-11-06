# Panier v2 — trust-gated browser synchronisation (draft)

**Status:** isolated browser adapter, experimental, not called by the deployed
PWA. Requires independent protocol review and eventual cross-device freshness
design. Stacked on PR #27.

The cryptographic primitives, signed HTTP API and local mutation persistence
already existed in PRs #15–#27, but were independent components. This PR
introduces `v2/trusted-sync.mjs` and `createTrustedSync` to connect them
without permitting the server to establish membership trust.

## Required inputs

- `db`: v2 IndexedDB list/outbox database from `v2/storage.mjs`.
- `trustDb`: a **separately opened IndexedDB trust store** with a locally
  pinned owner genesis or owner-signed physical-QR root from PR #27.
- `listId`, `memberId`, `memberSigningPrivateKey`: actual registered
  device identity; the implementation signs every HTTP request and verifies
  the key against the locally verified membership log.
- `secretForEpoch(epoch)`: **local, trusted epoch secret resolver**. Never
  derive list secrets from server-returned keys or the signed mutation
  envelope. Missing old-epoch keys prevent verifying old operations.
- `baseUrl`: isolated v2 API HTTPS origin (HTTP allowed only for loopback).
  `request` is injectable for local tests; real callers must use a trusted
  transport.

No silent trust-on-first-use or fallback to server-provided owner public keys.

## Sync sequencing and fail-closed rules

`sync()` (or `pull()`) uses the existing deterministic v2 coordinator:

1. Read the locally pinned owner root. If missing, **do not sync**.
2. Fetch the entire signed membership history with a newly signed HTTP
   request. Verify the full history and *atomically extend* the saved
   checkpoint. A stale or contradictory signed branch fails closed.
3. Verify that the device is a current active member and that its signing
   private key matches its authenticated public key.
4. Pull an encrypted operation page using a separate signed API request.
   **Refresh membership again after the network response** and before
   committing the page. Decrypt/verify each signed operation against the
   verified membership key history and locally supplied epoch secret.
5. Commit accepted operations and outbox acknowledgements to IndexedDB
   transactionally. Plain HTTP success does not acknowledge pending edits.
6. Before uploading every queued operation, refresh membership. Refuse
   expired, removed or mismatched signing devices and any ciphertext sealed
   under a non-current epoch. Never silently re-encrypt stale outbox bytes.
7. Push the **durably saved exact ciphertext** through a signed HTTP
   request; the existing sync coordinator requires a subsequent verified
   pull before considering the edit acknowledged.

Historical member key resolution accepts operations from a member **only**
for epochs from that member's signed join until its signed revocation epoch.
This allows an already-accepted epoch-1 operation to be authenticated even
after its author is removed in epoch 2.

## Known limits and open security gates

- **Signed membership snapshots are not independently fresh.** If a malicious
  server withholds a never-seen newer event, local checkpoint pinning cannot
  detect that. Offline clients cannot get universal latest-state proof without
  additional authenticated cross-device checkpoint sharing/transparency.
- **Historical append ordering ambiguity:** the encrypted accepted log has
  no signed cryptographic link between each accepted revision and the exact
  membership checkpoint at acceptance time. A member joining partway through
  an epoch cannot be proven to have been authorized for a same-epoch earlier
  accepted revision on an untrusted server. The server API enforces
  membership at append time, but a hostile-server proof remains incomplete.
  Future design must include checkpoint/authorization evidence in accepted
  revision receipts or a signed interleaved event log.
- **TOCTOU remains theoretically possible:** membership can change after
  the final history refresh while a request or local transaction proceeds.
  This code catches observed forks and mismatches, but a server that
  deliberately withholds changes can still cause stale decisions. The DO
  must enforce member/epoch authorization atomically for uploads.
- **Offline rebasing remains unimplemented.** An old-epoch pending mutation
  causes a `stale-epoch` failure without changing its durable outbox record.
  A reviewed flow will need new IDs and explicit conflict resolution.
- **No trusted key lifecycle** (recovery kit, cross-device secret persistence,
  owner transfer), no public release and no malicious JavaScript defense.
- No private owner signing keys, epoch secrets or plaintext mutation payloads
  are sent to the server; local optimistic plaintext still exists.
- Full-history refresh is intentionally conservative and inefficient;
  eventual authenticated incremental checkpoints/signed snapshot retention
  need review before larger lists.

## Tests

`test/v2-trusted-sync.test.mjs` covers signed member historical epoch
eligibility and fail-closed unknown identities.

Real Chromium and Firefox `test/v2-storage.test.mjs` covers:
- owner-pinned membership refresh and signed HTTP upload;
- a fully encrypted local mutation going through signed push, verified pull
  and transactional outbox acknowledgement;
- substituted malicious genesis rejected before any local state advance;
- epoch-1 pending encrypted edits quarantined when the verified ledger has
  rotated to epoch 2, with the exact bytes and pending entry preserved.

The test transport in the browser suite is synthetic; the existing
`test/v2-worker-api.test.mjs` independently exercises signed HTTP against
the real isolated local Cloudflare DO runtime. Production integration is
**not** enabled and tests are **not** an independent security review.
