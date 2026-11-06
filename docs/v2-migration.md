# Panier v1 → v2 migration and rollout plan

Status: **Explicit v1 → v2 copy approved (2026-11-06); implementation and rollout remain unapproved pending verification.**  
Tracks [#2](https://github.com/pyrocklast/panier/issues/2). Read with [ADR-0001](./adr/0001-panier-v2.md).

## Existing data and compatibility boundaries

The current browser app uses one `localStorage["panier"]` object:
`{key, dev, clock, seq, items, outbox}`. Its `key` is the shared 256-bit
pairing secret; the current Cloudflare Worker derives a list identity from the
key and stores an append-only encrypted log under a shared-token authorization
model. Existing devices use the same list secret; there are no independent
member credentials or key epochs.

**Never overwrite this storage key or reinterpret the existing URL fragment
`#k=` as a v2 invitation.** Retain the old encryption and authentication
mechanisms for migration only, in a clearly isolated adapter. Do not send the v1
pairing key or decrypted contents to the server during migration.

The Go/Raspberry Pi implementation is out of scope. Do not silently migrate
or delete its data, and do not claim Go installations can join v2 lists.

## Migration choice — approved

**Use parallel v2 lists and an explicit client-side copy**, not a silent
in-place server schema upgrade. This is an approved product decision.
A user must intentionally trigger each copy and must be informed that the
original and copied lists do not remain synchronised. No automatic upgrade,
server-side conversion, or bidirectional bridge is permitted.

1. A v1 installation keeps functioning while a separate v2 app/protocol is
   developed and tested. Distinct API paths, cache names, storage namespaces,
   worker assets and IndexedDB versions avoid breaking running v1 clients.
2. Offer an explicit `Copy this list to Panier v2` action after the v2
   crypto/invitation and offline code is stable.
3. Read the v1 local store *without modifying it*. Derive the v1 key and fetch
   missing encrypted history as necessary; validate/decrypt locally.
4. Resolve or preserve the entire v1 outbox **before** declaring any migration
   complete. If the v1 service is unavailable, offer only a clearly labelled
   local snapshot copy; never claim it contains other devices' latest changes.
5. Convert the complete validated v1 state (items, sections, checked status,
   positions and relevant history semantics) to v2 events or an authenticated
   initial snapshot. Create a **new random** v2 list ID and content key.
6. Persist new local credentials, state and any import progress atomically in
   IndexedDB. Upload encrypted data to the new v2 list, then verify the server
   cursor and a fresh client pull before marking the new list as ready.
7. Keep v1 untouched and available. Show the new v2 list independently.
   Explain that v1 and v2 no longer synchronise with one another; any future
   v1 changes must be explicitly copied again or users must stop using v1.
8. Offer invitation and recovery export from the new v2 list. Do not assume
   the old v1 bearer secret grants v2 membership.

This is a **copy**, not a live bridge. Avoid two-way syncing across distinct
security models: that doubles conflict and revocation complexity.

## Data fidelity and privacy

Define a documented mapping before coding. V1 includes historical checked
items and per-field conflict metadata; decide whether to preserve history or
only the resolved materialized state. At minimum preserve:

- Visible item names, checked state and section membership.
- Custom sections, names, ordering and colours.
- Checked timestamps where the app's behaviour relies on them.
- Duplicate items and IDs wherever safe; no merging by item name.
- Pending offline edits, even if the server never received them.

Do not invent purchase history, owners or actor attribution for old data.
Record any lost semantics explicitly in the migration preview. v1 `dev` IDs
are not v2 authenticated member identities; generate new credentials.

Data must remain end-to-end encrypted: no plaintext item data, recovery secret
or v1 master key in network requests, logs, telemetry or GitHub Actions output.

## Safety invariants

- No write to v1 `localStorage["panier"]` from migration code.
- No v1 Durable Object schema modifications or deletes.
- No v1 secret reused as a v2 list key, access token or member credential.
- A failed migration can be retried without creating a corrupted or
  duplicate v2 list; use an import operation ID and idempotent checkpoints.
- A browser crash after writing v2 local state but before server acknowledgement
  leaves a recoverable pending migration, not a success state.
- A v2 storage failure never deletes or replaces the original v1 list.
- A migration from a device that is behind others must say so; a local snapshot
  alone cannot prove that it has the latest shared state.
- Re-reading invalid/corrupt v1 data must fail visibly and preserve it.

## Validation and rollout

1. Use synthetic v1 fixtures for empty, large and multiple-section lists;
   checked/hidden items; edits and removals; malformed data and full outbox.
2. Run a real two-device v1 scenario: disconnect one device, edit on both,
   reconnect, finish convergence, then import and compare resolved states.
3. Test interrupted import at each boundary: before local commit, after
   commit, before upload, after upload and before acknowledgement.
4. Verify v1 links still open v1 and do not accidentally enroll a v2 member.
5. Validate in a staging Cloudflare account with a disposable test dataset.
6. Roll out v2 behind a distinct URL or explicit user-controlled upgrade
   action. Do **not** replace the v1 production UI automatically.
7. Keep a tested v1 rollback route. A rollout is complete only when the
   new v2 list can be restored from recovery material on a clean browser.
8. Communicate that losing all keys and all recovery copies makes anonymous
   E2EE data unrecoverable.

## Copy-flow decisions

- A v1 list remains accessible after copying, independently of the new v2 list.
- A copied list receives a fresh list ID and cryptographic key; existing v1
  pairing links do not confer membership or access to the v2 copy.
- The action is labelled **Copy**, not Move or Upgrade; the UI must make clear
  that changes to the original do not propagate to its copy.
- Never silently consume or discard unsent v1 edits. If the original is not
  fully synchronised, clearly distinguish copying the available local state
  from copying the latest state across all devices.
- Preserve v1 storage and server data for rollback; a later deliberate removal
  of v1 is a separate release decision.

## Launch gates

- [ ] Threat model and invitation/key epoch protocol reviewed (#2, #5, #6).
- [ ] v2 IndexedDB schema plus crash-safe migration mechanism tested (#3).
- [ ] Multiple independent lists and members work (#4, #10).
- [ ] Mutation idempotency and offline convergence tests pass on Cloudflare
      Durable Objects (#7, #8, #9, #11).
- [ ] Recovery export and re-import tested on a clean browser (#10, #11).
- [ ] Accessible user confirmation and explicit v1/v2 coexistence messaging.
- [ ] No v1 data altered by either successful or failed migrations.

**Non-goal:** changing the Raspberry Pi/Go server as part of v2.
