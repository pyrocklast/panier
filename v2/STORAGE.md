# Panier v2 local persistence (issue #3)

**Standalone prototype.** Nothing in the production v1 app currently imports
`v2/storage.mjs`. There is no migration from v1, E2EE key handling, server
endpoint, realtime connection or account implementation here.

## Browser API

```js
import {
  openPanierDatabase, createLocalList, commitSealedLocalMutation,
  readLocalList, acceptRemoteOperations, loadSealedMutation, requestPersistentStorage,
} from "./storage.mjs";

const db = await openPanierDatabase();
await createLocalList(db, "your-random-list-id");
const draft = {
  listId: "your-random-list-id",
  id: "your-random-mutation-id",
  type: "item.add",
  payload: { id: "your-random-item-id", name: "Milk", position: "a" },
};
// 'sealAndSign' must come from the reviewed cryptographic protocol.
// It prepares ONE authenticated encrypted wire envelope before this transaction.
const sealed = await sealAndSign(draft);
await commitSealedLocalMutation(db, draft, sealed);
// Only now may the UI say "Saved locally".
```

`createLocalList` prepares local state only. Creating server membership, keys
and an encrypted list is a separate future operation. Actual IDs must use
sufficient randomness (see `newId` in `domain.mjs`).

`readLocalList` returns:
- `accepted`: server-confirmed materialized list state and contiguous cursor;
- `local`: accepted state **plus optimistic pending changes**;
- `pending`: locally ordered unsent/unacknowledged operations;
- `nextLocalSeq`: monotonic local counter for ordering pending work.

`commitSealedLocalMutation` requires a **prepared, already encrypted and
signed** opaque envelope `{ listId, id, ciphertext }`. The ciphertext string
is the complete, immutable wire representation (its exact encoding is not yet
defined). The function validates its envelope shape and list/mutation binding;
**it does not perform or verify cryptography**. It writes the encrypted envelope,
the pending mutation and a newly derived `local` projection in the **same
IndexedDB readwrite transaction**. The transaction
is awaited through `oncomplete`, not request-level `onsuccess`. If a
quota, blocked, closed database or validation failure occurs, the promise
**rejects**; the caller must not claim that the edit was saved.

`acceptRemoteOperations` accepts only an already authenticated/decrypted,
contiguous server operation batch and persists the new accepted cursor,
the rebased optimistic view, and any matching outbox deletions atomically.
**Never pass untrusted server payloads directly to this function:** v2's
future crypto layer must verify signatures, actor authorization, list/epoch
binding and immutable mutation IDs beforehand. A remote server may never be
allowed to forge an acknowledgement for a pending mutation. Validating the
plaintext operation shape is not sufficient.

The outbox uses `[listId, mutationId]` as its unique key, preventing
duplicate local IDs. `nextLocalSeq` determines insertion order for
optimistic replay. IndexedDB readwrite transactions serialize writes across
tabs sharing the same browser origin; future `BroadcastChannel`/Web Locks
are useful for UI notifications and reducing duplicate network uploads,
but are not required for atomic database writes.


`loadSealedMutation(db, listId, mutationId)` returns the exact stored
envelope string after restart. A duplicate mutation ID cannot replace it.
Legacy v2 prototype outbox rows without encrypted envelopes remain local
but cannot be uploaded: the loader fails explicitly and a reviewed repair
procedure is required. Version 2 of the IndexedDB schema does not modify the
existing v1 `localStorage["panier"]` data.

The accepted-operation transaction also verifies that an acknowledgement for
a locally pending mutation ID has matching operation type and payload. This
prevents clearing pending edits on a mismatched accepted item; it **does not**
substitute for full signed envelope verification. The pending plaintext payload
still exists in local IndexedDB for optimistic editing and is not a secure
at-rest cache.

## Failure behaviour and error handling

- `openPanierDatabase` fails when IndexedDB is unavailable, emits
  `onBlocked` for a blocked schema upgrade, and closes its connection
  automatically upon `versionchange`.
- Persistence operations reject with `StorageFailure`, whose `code` is
  `quota`, `version`, `unavailable` or `storage`. The UI should display
  an actionable failure state and preserve the edit in the input if possible.
- A failed transaction changes **neither** materialized list state nor outbox.
- `requestPersistentStorage()` reports `{supported, granted}`; even a
  granted result is not a durable backup or disaster-recovery guarantee.
- No successful return from the API means persistence is not confirmed.
- Local IndexedDB may contain **plaintext** materialized shopping data and
  pending operations accessible to scripts running in the app origin. It is
  not equivalent to encrypted local storage. Before shipping v2, the E2EE
  architecture/security review must explicitly accept or modify this local
  cache design. Do not store encryption keys here without the key-lifecycle
  specification in PR #12.

## Consistency and limitations

- The accepted revision is never advanced by a provisional local edit.
- The projection derives provisional revisions only in memory to reuse the
  pure reducer; provisional numbers are not written as accepted operations.
- The authoritative server must make mutation IDs idempotent and revisions
  permanently immutable. A replay of a previously applied revision cannot
  be authenticated solely by this local DB.
- Pending operations are removed only when their authenticated accepted-log
  counterparts are applied. This avoids temporarily making edits disappear
  when an upload succeeds but the remote log has not been downloaded.
- The current schema is v2 of **`panier-v2`**, distinct from v1's existing
  `localStorage["panier"]`. Future IndexedDB migrations require version
  increments and explicit tests; this PR does not import v1 data.
- Snapshot/restore, encrypted queued payloads, multi-tab notifications,
  cross-installation sync, interrupted key rotation and browser-key storage
  remain future #4/#6/#7/#9/#10 work.

## Tests

Run after installing Playwright browsers:

```sh
node --test test/v2-domain.test.mjs
node --test test/v2-storage.test.mjs
BROWSER=firefox node --test test/v2-storage.test.mjs
```

Storage tests run against genuine browser IndexedDB on a local loopback HTTP origin, using an ephemeral static server.
They verify reload, concurrent-tab writes, atomic accepted/optimistic/outbox
transitions, rollback on duplicate/invalid/missing revisions, quota/unavailable
error reporting, independent lists, versionchange and persistence capability.

The existing CI job runs these after installing browsers. The production
app and Cloudflare API are not involved.
