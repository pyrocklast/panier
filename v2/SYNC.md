# Panier v2 sync coordinator — isolated prototype (#9)

Status: **draft implementation, NOT enabled in production**.

The implementation in `v2/sync.mjs` runs a single bounded sync pass on top
of the IndexedDB contract from stacked PR #14 and the pure reducer from #13.
It deliberately has **no HTTP endpoints, key handling, WebSocket connection or
v1 integration**. Cryptographic wire formats and member authentication remain
under security design review in PR #12.

## Protocol-independent guarantees

1. Pull from the *durably applied* cursor, not from wall-clock timestamps.
2. Validate the advertised latest revision and contiguous, strictly ordered
   encrypted envelopes. Missing pages are explicit failures, not silent gaps.
3. Pass each envelope through `security.decodeAndVerify(listId, envelope)`.
   The implementation MUST verify signatures, actor authorization, list ID,
   epoch, immutable mutation identity and ciphertext authentication.
4. Only after verification, atomically commit accepted operations, cursor,
   optimistic rebase and matching outbox deletions via IndexedDB.
5. For local pending edits, call `security.loadSealed(listId, mutationId)`
   to retrieve a *durably stored*, signed and encrypted envelope. Never
   encrypt or sign a fresh payload during retries. The same mutation ID must
   map to identical wire bytes, including across browser restarts.
6. Send the ciphertext to `transport.push`; its success alone is **not**
   acknowledgement. Pull the accepted log and clear pending edits only
   when their authenticated accepted-log counterparts are applied.
7. An invalid verified envelope, missing local encrypted payload, network
   error or incomplete remote history **throws** and leaves unacknowledged
   edits queued locally.

A returned `synced: true` means that the caller found no pending mutations
after the final verified pull. It does not prove that a hostile server has
served the freshest history. It is not appropriate for a global UI status
unless all locally active lists and a bounded freshness policy are considered.

## Required future adapters

```js
const storage = { readLocalList, acceptRemoteOperations };
const transport = {
  async pull(listId, sinceRevision) {
    // Returns {latest, changes: [{revision,id,ciphertext,...}]}
    // No plaintext list fields may be sent to the server.
  },
  async push(listId, sealed) {
    // Sends ONLY previously persisted encrypted and authenticated bytes.
    // Server idempotently binds list + mutation ID -> immutable content.
  },
};
const security = {
  async decodeAndVerify(listId, opaqueEnvelope) {
    // Verify all crypto metadata/identity/epoch/signature and decrypt.
    // Returns {listId,id,revision,type,payload}.
  },
  async loadSealed(listId, mutationId) {
    // Returns the EXACT durable envelope saved at local edit time.
    // Returns {listId,id,ciphertext} with other authenticated metadata.
  },
};
const result = await syncOnce({ db, listId, storage, transport, security });
```

The test adapter deliberately substitutes inert strings for ciphertext to
exercise sync sequencing. **It is NOT a crypto implementation and must never
be copied into the browser application.**

## Blocking items before enabling uploads

- **Durable sealed outbox (storage boundary now implemented in stacked PR):**
  `commitSealedLocalMutation` atomically stores local edits with a preprepared
  immutable envelope, and `loadSealedMutation` retrieves the same bytes after
  restart. The crypto protocol still must implement `sealAndSign` and verify
  the envelope before storage; tests use inert placeholders, not cryptography.
  The transport is **not ready for production** until reviewed E2EE/signing,
  identity, epoch fencing and the actual backend exist.
  Existing experimental v2 outbox entries lacking sealed bytes are NOT sent
  and require an explicit reviewed re-encryption migration.
- **Protocol/security (#2, #4–#7):** final signed canonical envelope format,
  anonymous member proof-of-possession, key-epoch fencing and revocation
  rules, and idempotent server acknowledgement.
- **Cross-tab sync (#9):** this pass does not acquire a Web Lock or listen for
  BroadcastChannel notifications. Concurrent tabs may upload a mutation
  twice, which the backend MUST handle idempotently; network coordination and
  user-facing status belong to a later integration.
- **Paging:** limit is 1,000 pages of up to 1,000 operations per pass. If the
  limit is exceeded, the call fails with `limit`; callers must resume rather
  than skipping history. An empty page claiming unseen changes is an error.
- **Hostile-server limitations:** the backend can withhold changes; completed
  pull does not imply cryptographic freshness or availability.
- **Snapshots and compaction:** the server must not prune a required log range
  without a separately verified authenticated snapshot protocol.
- **Recovery:** do not sync or export plaintext cached state under a false
  promise of E2EE. The local plaintext cache needs a documented security
  decision in PR #12.

## Tests

`node --test test/v2-sync.test.mjs` covers revision order, pagination,
missing operations, invalid envelopes, failed upload, duplicate retry,
durable ciphertext requirement, late server visibility and offline-style
reconciliation. It is included in PR CI. The existing real-browser IndexedDB
suite continues to run separately; end-to-end crypto/Worker tests have not
been implemented.

The production v1 PWA and Raspberry Pi/Go implementation are untouched.
