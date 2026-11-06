// Panier v2 domain model. No browser, database, network or crypto dependencies.
// The server assigns contiguous revisions. All clients replay the same accepted log.
// This module does NOT authenticate operations: callers must verify/decrypt them first.

/** @typedef {{id:string,name:string,quantity:string|null,sectionId:string|null,position:string,checked:boolean,deleted:boolean}} Item */
/** @typedef {{id:string,name:string,position:string,deleted:boolean}} Section */
/** @typedef {{listId:string,revision:number,items:Record<string,Item>,sections:Record<string,Section>}} ListState */
/** @typedef {{listId:string,revision:number,id:string,type:string,payload:object}} AcceptedOperation */

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const POSITION = /^[0-9A-Za-z._~-]{1,64}$/;
const ITEM_FIELDS = new Set(["name", "quantity", "sectionId", "position", "checked"]);
const SECTION_FIELDS = new Set(["name", "position"]);
const TYPES = new Set(["item.add", "item.patch", "item.delete", "section.add", "section.patch", "section.delete"]);

const fail = message => { throw new TypeError(message); };
const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
const id = v => typeof v === "string" && ID.test(v);
const keysOnly = (v, allowed) => Object.keys(v).every(k => allowed.has(k));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const assert = (ok, message) => { if (!ok) fail(message); };
const maxString = (v, n) => typeof v === "string" && v.length > 0 && v.length <= n && v.trim() === v;
const fieldValid = (k, v) => {
  switch (k) {
    case "name": return maxString(v, 120);
    case "quantity": return v === null || maxString(v, 60);
    case "sectionId": return v === null || id(v);
    case "position": return typeof v === "string" && POSITION.test(v);
    case "checked": return typeof v === "boolean";
    default: return false;
  }
};
const assertFields = (fields, allowed, required = []) => {
  assert(record(fields) && keysOnly(fields, allowed), "unknown or invalid fields");
  for (const k of required) assert(own(fields, k), "missing field: " + k);
  for (const [k, v] of Object.entries(fields)) assert(fieldValid(k, v), "invalid field: " + k);
};
const payloadKeys = (payload, fields) => {
  assert(record(payload) && keysOnly(payload, new Set(fields)), "unknown payload field");
};

export function newId() {
  // Secure randomness; no time-, name- or device-derived identifiers.
  return crypto.randomUUID();
}

/** @returns {ListState} */
export function emptyList(listId) {
  assert(id(listId), "invalid list id");
  return { listId, revision: 0, items: {}, sections: {} };
}

/** Validate the plaintext operation *after* the crypto layer authenticates it. */
export function validateOperation(op) {
  assert(record(op) && keysOnly(op, new Set(["listId", "revision", "id", "type", "payload"])), "invalid operation envelope");
  assert(id(op.listId) && id(op.id), "invalid operation ids");
  assert(Number.isSafeInteger(op.revision) && op.revision > 0, "invalid revision");
  assert(TYPES.has(op.type), "unsupported operation type");
  const p = op.payload;
  switch (op.type) {
    case "item.add":
      payloadKeys(p, ["id", "name", "quantity", "sectionId", "position", "checked"]);
      assert(id(p.id), "invalid item id");
      assertFields(p, ITEM_FIELDS, ["name", "position"]);
      break;
    case "section.add":
      payloadKeys(p, ["id", "name", "position"]);
      assert(id(p.id), "invalid section id");
      assertFields(p, SECTION_FIELDS, ["name", "position"]);
      break;
    case "item.patch":
    case "section.patch": {
      payloadKeys(p, ["id", "fields"]);
      assert(id(p.id), "invalid target id");
      const allowed = op.type === "item.patch" ? ITEM_FIELDS : SECTION_FIELDS;
      assertFields(p.fields, allowed);
      assert(Object.keys(p.fields).length > 0, "empty patch");
      break;
    }
    case "item.delete":
    case "section.delete":
      payloadKeys(p, ["id"]);
      assert(id(p.id), "invalid target id");
      break;
  }
  return op;
}

/**
 * Deterministic accepted-log reducer, free of side effects.
 * - Accepted revisions must be contiguous; a gap signals missing history.
 * - Replaying an already-applied revision is harmless (the server's immutable
 *   revision -> mutation mapping is an external protocol invariant).
 * - Deletes create permanent tombstones; later patches/adds cannot resurrect.
 * - A patch of an unknown record is a no-op, but still advances revision.
 * - Last accepted patch wins for scalar fields; independent fields coexist.
 * - Ordering positions may tie: readers must sort by (position, id).
 * @param {ListState} state
 * @param {AcceptedOperation} op
 * @returns {ListState}
 */
export function applyOperation(state, op) {
  validateOperation(op);
  assert(record(state) && state.listId === op.listId && Number.isSafeInteger(state.revision), "wrong list or state");
  if (op.revision <= state.revision) return state;
  assert(op.revision === state.revision + 1, "missing prior revision");
  const items = { ...state.items }, sections = { ...state.sections };
  const p = op.payload;
  switch (op.type) {
    case "item.add":
      if (!own(items, p.id)) {
        items[p.id] = {
          id: p.id, name: p.name, quantity: p.quantity ?? null,
          sectionId: p.sectionId ?? null, position: p.position,
          checked: p.checked ?? false, deleted: false,
        };
      }
      break;
    case "section.add":
      if (!own(sections, p.id)) sections[p.id] = { id: p.id, name: p.name, position: p.position, deleted: false };
      break;
    case "item.patch":
      if (own(items, p.id) && !items[p.id].deleted) items[p.id] = { ...items[p.id], ...p.fields };
      break;
    case "section.patch":
      if (own(sections, p.id) && !sections[p.id].deleted) sections[p.id] = { ...sections[p.id], ...p.fields };
      break;
    case "item.delete":
      items[p.id] = { ...(items[p.id] || {
        id: p.id, name: "", quantity: null, sectionId: null, position: "0", checked: false,
      }), deleted: true };
      break;
    case "section.delete":
      sections[p.id] = { ...(sections[p.id] || { id: p.id, name: "", position: "0" }), deleted: true };
      break;
  }
  return { listId: state.listId, revision: op.revision, items, sections };
}

/** Apply a contiguous accepted log, without mutating the input state. */
export function replay(state, operations) {
  assert(Array.isArray(operations), "expected operations");
  return operations.reduce(applyOperation, state);
}

const compare = (a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Project visible items, placing references to missing/deleted sections in the ungrouped section. */
export function visibleItems(state) {
  return Object.values(state.items).filter(item => !item.deleted)
    .map(item => ({
      ...item,
      sectionId: item.sectionId && state.sections[item.sectionId] && !state.sections[item.sectionId].deleted
        ? item.sectionId : null,
    }))
    .sort(compare);
}

/** Return visible sections sorted by position, then stable ID. */
export function visibleSections(state) {
  return Object.values(state.sections).filter(section => !section.deleted).sort(compare);
}
