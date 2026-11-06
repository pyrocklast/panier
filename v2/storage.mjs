// Panier v2 local persistence. This module does not alter v1 localStorage.
// Accepted state + optimistic projection + outbox are committed atomically.
// No network, crypto, UI or framework dependency.

import { applyOperation, emptyList, replay, validateOperation } from "./domain.mjs";

export const DATABASE_NAME = "panier-v2";
export const DATABASE_VERSION = 1;

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
 * Persist an optimistic mutation and its outbox entry IN ONE transaction.
 * No caller should report "saved locally" until this promise resolves.
 * A second tab using the same DB serialises through the write transaction.
 */
export async function commitLocalMutation(db, draft) {
  const entry = validateDraft(draft);
  return transaction(db, "readwrite", async (lists, outbox) => {
    const recordReq = request(lists.get(entry.listId));
    const pendingReq = pendingFor(outbox, entry.listId);
    const [record, pending] = await Promise.all([recordReq, pendingReq]);
    if (!record) throw new Error("list does not exist");
    if (pending.some(p => p.id === entry.id)) throw new Error("duplicate local mutation id");
    const localSeq = record.nextLocalSeq + 1;
    if (!Number.isSafeInteger(localSeq)) throw new Error("local sequence exhausted");
    const prepared = { ...entry, localSeq };
    const local = localProjection(record.accepted, pendingInOrder([...pending, prepared]));
    // Both writes either commit together, or both roll back.
    outbox.add(prepared);
    lists.put({ ...record, local, nextLocalSeq: localSeq });
    return { local, pendingCount: pending.length + 1 };
  });
}

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
