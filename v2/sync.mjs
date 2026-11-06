// Panier v2 sync coordinator: no fetch, crypto, timers, UI or v1 dependencies.
// Dependencies are passed explicitly so the cryptographic protocol cannot be
// silently replaced by an unverified plaintext transport.

/**
 * @typedef {{readLocalList: Function, acceptRemoteOperations: Function}} Storage
 * @typedef {{pull: Function, push: Function}} Transport
 * @typedef {{decodeAndVerify: Function, loadSealed: Function}} Security
 */

/** Error that callers can present without claiming an edit has synced. */
export class SyncFailure extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "SyncFailure";
    this.code = code;
  }
}

const fail = (code, message) => { throw new SyncFailure(code, message); };
const validRevision = n => Number.isSafeInteger(n) && n >= 0;
const maxSafePages = 1000;
const maxPageSize = 1000;

/**
 * Reconcile an encrypted server log into a verified local database snapshot.
 *
 * A caller-provided security adapter MUST cryptographically authenticate and
 * decrypt each operation, including actor, list, key epoch, canonical signed
 * bytes and immutable mutation ID mapping. There is no identity/auth in here.
 *
 * The storage contract is the v2 IndexedDB module:
 * readLocalList(db, listId) and acceptRemoteOperations(db, listId, ops).
 * Client-side revision continuity is checked before and during the commit.
 *
 * @param {object} options
 */
export async function pullVerified({
  db, listId, storage, transport, security, maxPages = maxSafePages,
}) {
  if (!db || typeof listId !== "string" || !storage ||
      typeof storage.readLocalList !== "function" ||
      typeof storage.acceptRemoteOperations !== "function" ||
      typeof transport?.pull !== "function" ||
      typeof security?.decodeAndVerify !== "function") {
    throw new TypeError("missing verified sync dependency");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > maxSafePages) {
    throw new TypeError("invalid maxPages");
  }
  let pages = 0, applied = 0;
  while (pages < maxPages) {
    const local = await storage.readLocalList(db, listId);
    if (!local) fail("missing-list", "List is not available locally");
    const cursor = local.accepted.revision;
    let page;
    try { page = await transport.pull(listId, cursor); }
    catch (error) {
      if (error instanceof SyncFailure) throw error;
      throw new SyncFailure("network", "Unable to download changes", error);
    }
    if (!page || !validRevision(page.latest) || !Array.isArray(page.changes) ||
        page.changes.length > maxPageSize || page.latest < cursor) {
      fail("protocol", "Server returned an invalid revision page");
    }
    if (page.changes.length === 0) {
      if (page.latest !== cursor) fail("gap", "Server omitted required changes");
      return { revision: cursor, applied, pages: pages + 1 };
    }
    const verified = [];
    let expected = cursor + 1;
    for (const opaque of page.changes) {
      if (!opaque || opaque.revision !== expected || opaque.revision > page.latest ||
          typeof opaque.id !== "string" || opaque.id.length === 0) {
        fail("gap", "Server supplied out-of-order or missing revisions");
      }
      let operation;
      try { operation = await security.decodeAndVerify(listId, opaque); }
      catch (error) { throw new SyncFailure("verification", "Encrypted operation could not be verified", error); }
      if (!operation || operation.listId !== listId || operation.revision !== expected ||
          operation.id !== opaque.id) {
        fail("verification", "Verified operation does not match the envelope");
      }
      verified.push(operation);
      expected++;
    }
    // Cursor and outbox acknowledgement happen in the storage transaction.
    await storage.acceptRemoteOperations(db, listId, verified);
    applied += verified.length;
    pages++;
    if (expected - 1 === page.latest) {
      return { revision: expected - 1, applied, pages };
    }
  }
  fail("limit", "Too many pages: resume sync instead of silently skipping history");
}

/**
 * One bounded synchronisation pass: pull, push local pending mutations, pull.
 *
 * SECURITY BOUNDARY: loadSealed(listId, mutationId) must return a *previously
 * durably persisted*, signed and encrypted envelope for that exact pending
 * mutation ID. It must be byte-for-byte identical across process restarts.
 * This module intentionally does not encrypt plaintext outbox records or
 * generate a new ciphertext on retry: the durable sealed outbox is not yet
 * implemented and is a prerequisite for enabling uploads in production.
 *
 * The transport's push return value cannot acknowledge a local edit.
 * Only a verified copy of the mutation in the accepted remote log can
 * remove its outbox entry via acceptRemoteOperations.
 */
export async function syncOnce({
  db, listId, storage, transport, security, maxPages = maxSafePages,
}) {
  if (typeof transport?.push !== "function" ||
      typeof security?.loadSealed !== "function") {
    throw new TypeError("missing sealed-upload dependency");
  }
  const first = await pullVerified({ db, listId, storage, transport, security, maxPages });
  const snapshot = await storage.readLocalList(db, listId);
  if (!snapshot) fail("missing-list", "List is not available locally");
  let pushed = 0;
  for (const pending of snapshot.pending) {
    // A read after each accepted message avoids resending operations another
    // tab has already pulled. Duplicate sends must *also* be idempotent server-side.
    const now = await storage.readLocalList(db, listId);
    if (!now?.pending.some(entry => entry.id === pending.id)) continue;
    let sealed;
    try { sealed = await security.loadSealed(listId, pending.id); }
    catch (error) { throw new SyncFailure("seal", "Unable to load durable encrypted mutation", error); }
    if (!sealed || sealed.listId !== listId || sealed.id !== pending.id ||
        typeof sealed.ciphertext !== "string" || !sealed.ciphertext.length) {
      fail("seal", "Missing or mismatched durable encrypted mutation");
    }
    try { await transport.push(listId, sealed); }
    catch (error) {
      if (error instanceof SyncFailure) throw error;
      throw new SyncFailure("network", "Unable to upload encrypted mutation", error);
    }
    pushed++;
  }
  const second = await pullVerified({ db, listId, storage, transport, security, maxPages });
  const after = await storage.readLocalList(db, listId);
  if (!after) fail("missing-list", "List is not available locally");
  return {
    revision: after.accepted.revision,
    pending: after.pending.length,
    pushed,
    pulled: first.applied + second.applied,
    synced: after.pending.length === 0,
  };
}
