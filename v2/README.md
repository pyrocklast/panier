# Panier v2 domain prototype

This is an **isolated, dependency-free** first implementation for [issue #8](https://github.com/pyrocklast/panier/issues/8).
The v1 web application, API, persistence and pairing code are unchanged.

Run `node --test test/v2-domain.test.mjs` (Node 22, already used by CI).

## Domain contract

- A list is identified by an opaque, randomly generated ID.
- A **server-accepted** operation carries the list ID, a unique operation ID,
  a contiguous positive server revision, a type and a validated plaintext payload.
- `validateOperation` verifies the **shape**, not cryptographic authenticity.
  The future E2EE layer must verify signed metadata and decrypt/authenticate
  ciphertext **before** this module is called.
- `applyOperation(state, operation)` returns a new state, leaving its input
  untouched. Clients must replay accepted operations in increasing revision order.
  Gaps throw an error rather than risking silent data loss.
- Duplicate delivery of an already applied revision is harmless. The backend
  **must** guarantee an accepted revision is permanently bound to exactly one
  operation ID and payload; this reducer cannot verify earlier operation contents
  from a state snapshot. This invariant needs tests in #7.
- An unknown target for a patch is a no-op; deletion installs a tombstone even
  when the item is not yet known, preventing a late creation from resurrecting it.
- Two independent additions use different stable IDs and are both retained,
  including when names match. Last **server-accepted** patch wins for a field.
- Position values are opaque lexicographically sortable strings; equal positions
  are resolved using the stable ID. **Generating collision-resistant positions
  for insert/move operations is future UI/sync work**, not part of the reducer.
- Deleting a section does **not** delete its items. Items with missing or deleted
  sections appear ungrouped in the `visibleItems` projection.
- The reducer is authoritative **only for accepted operations**. Keeping the
  local optimistic state and queued offline operations is planned in #3/#9.
- IDs, plaintext fields and position tokens are bounded and checked before
  application. Null-prototype maps prevent special IDs from modifying object
  prototypes.

## Deliberate limitations

The domain module currently uses standard ES modules with JSDoc typedefs so
Node 22 can run the tests **without introducing TypeScript build tooling** or
dependencies into v1. TypeScript consumers can use these declarations via
editor inference; a dedicated `.d.ts` or typed conversion can follow if needed.

This is **not** a synchronisation engine, cryptographic protocol, persisted
database, permission checker or production migration. It does not make ordering
of offline wall-clock events meaningful: the server's accepted revision order
is the replay order. Rejected and rebased optimistic operations are handled by
the future sync coordinator.

For the threat model and unresolved encryption protocol see draft PR #12.
