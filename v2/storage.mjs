// Panier v2 local persistence. This module does not alter v1 localStorage.
// Accepted state + optimistic projection + outbox are committed atomically.
// No network, crypto, UI or framework dependency.

import { applyOperation, emptyList, replay, validateOperation } from "./domain.mjs";

export const DATABASE_NAME = "panier-v2";
export const DATABASE_VERSION = 2; // Enforce immutable sealed envelopes for new edits.

export class StorageFailure extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "StorageFailure";
    this.code = cause?.name === "QuotaExceededError" ? "quota"
      : cause?.name === "VersionError" ? "version"
      : cause?.name === "InvalidStateError" ? "unavailable" : "storage";
  }
}

const storageError = (message, cause) =>
  cause instanceof StorageFailure ? cause : new StorageFailure(message, cause);

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
});

const completion = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  tx.onerror = () => {}; // onabort carries the transaction failure
});

async function transaction(db, mode, callback) {
  let tx;
  try { tx = db.transaction(["lists", "outbox"], mode); }
  catch (error) { throw storageError("Unable to open local storage transaction", error); }
  const done = completion(tx);
  // The transaction may abort before the callback is done; avoid an unhandled rejection.
  done.catch(() => {});
  try {
    const result = await callback(tx.objectStore("lists"), tx.objectStore("outbox"));
    await done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch (_) { /* already aborted or committed */ }
    await done.catch(() => {});
    throw storageError("Unable to save or read Panier data", error);
  }
}

function pendingInOrder(entries) {
  return entries.sort((a, b) => a.localSeq - b.localSeq || a.id.localeCompare(b.id));
}

function localProjection(accepted, entries) {
  // Provisional revisions exist only in this projection. They are NEVER sent
  // to or persisted as accepted server revisions.
  return entries.reduce((state, entry) => applyOperation(state, {
    listId: entry.listId, id: entry.id,
    type: entry.type, payload: entry.payload, revision: state.revision + 1,
  }), accepted);
}

function validateDraft(draft) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft) ||
      Object.keys(draft).sort().join(",") !== "id,listId,payload,type") {
    throw new TypeError("invalid local mutation");
  }
  validateOperation({ ...draft, revision: 1 });
  return { listId: draft.listId, id: draft.id, type: draft.type, payload: draft.payload };
}

// The opaque ciphertext is a PRE-ENCODED signed/encrypted wire message.
// Cryptographic validity is the responsibility of the caller's protocol layer.
// This module only preserves the exact wire bytes and enforces binding to the
// local mutation identifier. Never accept plaintext fields as envelope keys.
function validateSealed(draft, sealed) {
  if (!sealed || typeof sealed !== "object" || Array.isArray(sealed) ||
      Object.keys(sealed).sort().join(",") !== "ciphertext,id,listId" ||
      sealed.listId !== draft.listId || sealed.id !== draft.id ||
      typeof sealed.ciphertext !== "string" ||
      sealed.ciphertext.length < 1 || sealed.ciphertext.length > 24 * 1024) {
    throw new TypeError("invalid or mismatched sealed mutation envelope");
  }
  return { listId: sealed.listId, id: sealed.id, ciphertext: sealed.ciphertext };
}

function pendingFor(store, listId) {
  return request(store.index("byList").getAll(IDBKeyRange.only(listId)));
}

/**
 * Open the versioned v2 database. Blocked upgrades reject instead of silently
 * appearing to hang; callers should ask users to close other Panier tabs.
 * Existing v1 browser data is not accessed.
 */
export function openPanierDatabase({
  name = DATABASE_NAME, onBlocked = () => {}, onVersionChange = () => {},
} = {}) {
  if (!globalThis.indexedDB) return Promise.reject(
    storageError("IndexedDB is unavailable", new DOMException("Storage unavailable", "InvalidStateError"))
  );
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(name, DATABASE_VERSION); }
    catch (error) { reject(storageError("Unable to open Panier storage", error)); return; }
    let settled = false;
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("lists")) db.createObjectStore("lists", { keyPath: "listId" });
      if (!db.objectStoreNames.contains("outbox")) {
        const outbox = db.createObjectStore("outbox", { keyPath: ["listId", "id"] });
        outbox.createIndex("byList", "listId");
      }
    };
    req.onblocked = () => {
      onBlocked();
      if (!settled) {
        settled = true;
        reject(storageError("A different tab is blocking the Panier database upgrade",
          new DOMException("Database upgrade blocked", "InvalidStateError")));
      }
    };
    req.onerror = () => {
      if (!settled) {
        settled = true;
        reject(storageError("Unable to open Panier storage", req.error));
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); onVersionChange(); };
      if (settled) { db.close(); return; }
      settled = true;
      resolve(db);
    };
  });
}

/** Create one independent list. Does not create a server list or encryption key. */
export async function createLocalList(db, listId) {
  const state = emptyList(listId);
  return transaction(db, "readwrite", async lists => {
    if (await request(lists.get(listId))) throw new Error("list already exists");
    lists.add({ listId, accepted: state, local: state, nextLocalSeq: 0 });
    return state;
  });
}

/** Return a consistent snapshot of accepted state, local projection and outbox. */
export async function readLocalList(db, listId) {
  return transaction(db, "readonly", async (lists, outbox) => {
    // Queue both reads before awaiting; IDB transactions may otherwise auto-close.
    const recordReq = request(lists.get(listId));
    const pendingReq = pendingFor(outbox, listId);
    const [record, pending] = await Promise.all([recordReq, pendingReq]);
    if (!record) return null;
    return { accepted: record.accepted, local: record.local,
      pending: pendingInOrder(pending), nextLocalSeq: record.nextLocalSeq };
  });
}

/**
 * Persist a prepared encrypted mutation together with its optimistic projection
 * and pending outbox entry in ONE transaction. The cryptographic caller MUST
 * prepare and authenticate the envelope BEFORE invoking this function.
 *
 * A successful return means the exact ciphertext is durable in IndexedDB.
 * Failed transactions cannot leave an edit without its ciphertext (or vice
 * versa). Neither saving nor loading the envelope performs encryption.
 */
export async function commitSealedLocalMutation(db, draft, sealed) {
  const entry = validateDraft(draft);
  const envelope = validateSealed(entry, sealed);
  return transaction(db, "readwrite", async (lists, outbox) => {
    const recordReq = request(lists.get(entry.listId));
    const pendingReq = pendingFor(outbox, entry.listId);
    const [record, pending] = await Promise.all([recordReq, pendingReq]);
    if (!record) throw new Error("list does not exist");
    if (pending.some(p => p.id === entry.id)) throw new Error("duplicate local mutation id");
    const localSeq = record.nextLocalSeq + 1;
    if (!Number.isSafeInteger(localSeq)) throw new Error("local sequence exhausted");
    const prepared = { ...entry, localSeq, sealed: envelope };
    const local = localProjection(record.accepted, pendingInOrder([...pending, prepared]));
    // State, outbox and ciphertext commit together. No network operation here.
    outbox.add(prepared);
    lists.put({ ...record, local, nextLocalSeq: localSeq });
    return { local, pendingCount: pending.length + 1 };
  });
}

/** Read EXACTLY the envelope bytes previously committed, never re-encrypt. */
export async function loadSealedMutation(db, listId, mutationId) {
  if (typeof listId !== "string" || typeof mutationId !== "string") {
    throw new TypeError("invalid mutation lookup");
  }
  return transaction(db, "readonly", async (_lists, outbox) => {
    const entry = await request(outbox.get([listId, mutationId]));
    if (!entry) return null;
    if (!entry.sealed) throw new StorageFailure(
      "Pending legacy mutation has no encrypted envelope; do not upload it");
    return validateSealed(entry, entry.sealed);
  });
}

/**
 * WARNING: older in-progress v2 prototype builds could store unsealed outbox
 * entries. Those entries remain local after an IndexedDB version upgrade, but
 * loadSealedMutation refuses to send them. A future reviewed re-encryption
 * migration must explicitly repair them without silently dropping edits.
 */
/**
 * Atomically apply authenticated/decrypted accepted operations, advance the
 * cursor and remove only matching outbox mutation IDs. Callers MUST verify
 * cryptographic authenticity and immutable revision mapping before this call.
 */
export async function acceptRemoteOperations(db, listId, operations) {
  if (!Array.isArray(operations)) throw new TypeError("expected operations");
  return transaction(db, "readwrite", async (lists, outbox) => {
    const recordReq = request(lists.get(listId));
    const pendingReq = pendingFor(outbox, listId);
    const [record, pending] = await Promise.all([recordReq, pendingReq]);
    if (!record) throw new Error("list does not exist");
    // replay validates list IDs, contiguous revisions, data shape and ordering.
    const accepted = replay(record.accepted, operations);
    // An accepted mutation ID MUST refer to the same locally queued action.
    // Otherwise a malicious/misconfigured server could clear work using an
    // unrelated payload with a colliding ID. Auth/signature verification is
    // additionally required by the caller before reaching this method.
    const byId = new Map(pending.map(entry => [entry.id, entry]));
    for (const op of operations) {
      const queued = byId.get(op.id);
      if (queued && (queued.type !== op.type ||
          JSON.stringify(queued.payload) !== JSON.stringify(op.payload))) {
        throw new Error("accepted mutation does not match queued content");
      }
    }
    const acknowledged = new Set(operations.map(op => op.id));
    const remaining = pending.filter(p => !acknowledged.has(p.id));
    const local = localProjection(accepted, pendingInOrder(remaining));
    for (const entry of pending) {
      if (acknowledged.has(entry.id)) outbox.delete([listId, entry.id]);
    }
    lists.put({ ...record, accepted, local });
    return { accepted, local, pendingCount: remaining.length };
  });
}

/** Persistent storage reduces eviction risk, but is not backup or guaranteed. */
export async function requestPersistentStorage() {
  if (!globalThis.navigator?.storage?.persist) return { supported: false, granted: false };
  try {
    return { supported: true, granted: !!(await navigator.storage.persist()) };
  } catch (error) {
    throw storageError("Unable to request persistent storage", error);
  }
}
