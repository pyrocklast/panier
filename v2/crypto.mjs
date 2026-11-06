// Experimental Panier v2 authenticated-encryption primitives.
// NOT a complete membership/QR/revocation protocol. No v1 or network access.
// The signed object deliberately excludes the server-assigned revision.

import { validateOperation } from "./domain.mjs";

const VERSION = 1;
const MAX_WIRE_CHARS = 24 * 1024;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const subtle = () => {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto is unavailable");
  }
  return crypto.subtle;
};
const check = (condition, message) => { if (!condition) throw new TypeError(message); };
const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys = (obj, keys) => isObject(obj) &&
  Object.keys(obj).sort().join(",") === [...keys].sort().join(",");
const byteArray = v => v instanceof Uint8Array && v.byteLength === 32;
const validId = v => typeof v === "string" && ID.test(v);
const validEpoch = v => Number.isSafeInteger(v) && v >= 1;
const bytes = value => utf8.encode(value);

function base64url(data) {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < input.length; i += 8192) {
    binary += String.fromCharCode(...input.subarray(i, i + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function unbase64url(text, limit = MAX_WIRE_CHARS) {
  check(typeof text === "string" && text.length > 0 &&
    text.length <= limit && /^[A-Za-z0-9_-]+$/.test(text), "invalid base64url");
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const decoded = Uint8Array.from(raw, ch => ch.charCodeAt(0));
  check(base64url(decoded) === text, "noncanonical base64url");
  return decoded;
}
const encodeWire = value => base64url(bytes(JSON.stringify(value)));
const readWire = text => {
  const data = unbase64url(text);
  const decoded = decoder.decode(data);
  const value = JSON.parse(decoded);
  check(isObject(value) && JSON.stringify(value) === decoded, "noncanonical envelope");
  return value;
};

// Recursively sort plaintext object keys. Reject non-JSON and exotic values.
// The client reducer validates the accepted operation's field semantics.
function canonical(value, depth = 0) {
  check(depth <= 12, "mutation nesting too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    check(Number.isSafeInteger(value), "invalid mutation number");
    return value;
  }
  if (Array.isArray(value)) {
    check(value.length <= 1000, "mutation array too long");
    return value.map(v => canonical(v, depth + 1));
  }
  check(isObject(value) && (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null), "invalid mutation data");
  const keys = Object.keys(value).sort();
  check(keys.length <= 100, "too many mutation fields");
  const result = Object.create(null);
  for (const key of keys) {
    check(key !== "__proto__" && key !== "constructor" &&
      key !== "prototype", "reserved mutation field");
    result[key] = canonical(value[key], depth + 1);
  }
  return result;
}
const meta = ({ listId, id, epoch, actorId }) =>
  ({ v: VERSION, listId, id, epoch, actorId });
const unsigned = ({ listId, id, epoch, actorId, nonce, data }) =>
  ({ ...meta({ listId, id, epoch, actorId }), nonce, data });

async function operationKey(listId, epoch, rawSecret) {
  check(byteArray(rawSecret) && validId(listId) && validEpoch(epoch),
    "invalid list encryption context");
  const master = await subtle().importKey("raw", rawSecret, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey({
    name: "HKDF", hash: "SHA-256",
    salt: bytes("panier-v2-list:" + listId),
    info: bytes("panier/v2/mutation/aes-gcm/epoch/" + epoch),
  }, master, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Generate an anonymous signing identity. Private key is non-extractable. */
export async function generateSigningIdentity() {
  const pair = await subtle().generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return {
    actorId: crypto.randomUUID(),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyJwk: await subtle().exportKey("jwk", pair.publicKey),
  };
}

/** Import a public key from an already authenticated membership record. */
export async function importMemberPublicKey(jwk) {
  check(exactKeys(jwk, ["kty", "crv", "x", "y", "ext", "key_ops"]) ||
    (isObject(jwk) && jwk.kty === "EC" && jwk.crv === "P-256"), "invalid member public key");
  check(jwk.kty === "EC" && jwk.crv === "P-256", "unsupported member key");
  return subtle().importKey("jwk", jwk,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/**
 * Produce an authenticated encrypted envelope BEFORE saving a local edit.
 * The return value fits v2/storage.mjs's {listId,id,ciphertext} contract.
 * It does NOT authorize a member or grant access to a list.
 */
export async function sealMutation({ draft, epoch, actorId, privateKey, listSecret }) {
  check(exactKeys(draft, ["listId", "id", "type", "payload"]), "invalid draft shape");
  check(validId(actorId) && validEpoch(epoch), "invalid actor or key epoch");
  validateOperation({ ...draft, revision: 1 });
  check(privateKey instanceof CryptoKey && privateKey.type === "private" &&
    privateKey.algorithm.name === "ECDSA", "invalid signing key");
  const plaintext = bytes(JSON.stringify(canonical({ type: draft.type, payload: draft.payload })));
  check(plaintext.length <= 12 * 1024, "mutation too large");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const header = meta({ listId: draft.listId, id: draft.id, epoch, actorId });
  const key = await operationKey(draft.listId, epoch, listSecret);
  const encrypted = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: bytes(JSON.stringify(header)), tagLength: 128 },
    key, plaintext);
  const body = unsigned({ ...header, nonce: base64url(nonce), data: base64url(encrypted) });
  const signature = await subtle().sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, bytes(JSON.stringify(body)));
  const ciphertext = encodeWire({ ...body, sig: base64url(signature) });
  check(ciphertext.length <= MAX_WIRE_CHARS, "encrypted envelope too large");
  return { listId: draft.listId, id: draft.id, ciphertext };
}

/**
 * Verify membership with an EXTERNALLY TRUSTED resolver, then verify signature
 * and decrypt. The resolver must check list-scoped actor authorization, epoch,
 * revocation and an authentic public-key binding. Never resolve signer keys
 * from the untrusted envelope itself.
 * The server supplies revision only AFTER committing immutable signed bytes.
 */
export async function openMutation({ listId, opaque, resolveMember, resolveListSecret }) {
  check(validId(listId) && isObject(opaque) &&
    validId(opaque.id) && Number.isSafeInteger(opaque.revision) &&
    opaque.revision > 0, "invalid remote operation");
  check(typeof resolveMember === "function" &&
    typeof resolveListSecret === "function", "missing trusted key resolvers");
  const envelope = readWire(opaque.ciphertext);
  check(exactKeys(envelope, ["v", "listId", "id", "epoch", "actorId", "nonce", "data", "sig"]) &&
    envelope.v === VERSION && envelope.listId === listId &&
    envelope.id === opaque.id && validEpoch(envelope.epoch) &&
    validId(envelope.actorId), "wrong list, ID or envelope version");
  // Reject re-ordered or otherwise non-canonical envelopes, not just
  // duplicate/extra JSON keys. This byte representation is the v1 wire format.
  check(JSON.stringify(envelope) === JSON.stringify({
    ...unsigned(envelope), sig: envelope.sig,
  }), "noncanonical signed envelope order");
  const nonce = unbase64url(envelope.nonce, 64);
  check(nonce.length === 12, "invalid nonce length");
  const ciphertext = unbase64url(envelope.data);
  const signature = unbase64url(envelope.sig, 256);
  check(signature.length === 64, "invalid ECDSA signature length");
  const memberKey = await resolveMember({
    listId, actorId: envelope.actorId, epoch: envelope.epoch,
  });
  check(memberKey instanceof CryptoKey && memberKey.type === "public" &&
    memberKey.algorithm.name === "ECDSA", "unknown or unauthorized signer");
  const body = unsigned(envelope);
  const verified = await subtle().verify(
    { name: "ECDSA", hash: "SHA-256" }, memberKey,
    signature, bytes(JSON.stringify(body)));
  check(verified, "invalid mutation signature");
  const listSecret = await resolveListSecret({ listId, epoch: envelope.epoch });
  const key = await operationKey(listId, envelope.epoch, listSecret);
  const plaintext = await subtle().decrypt({
    name: "AES-GCM", iv: nonce,
    additionalData: bytes(JSON.stringify(meta(envelope))), tagLength: 128,
  }, key, ciphertext);
  const decoded = JSON.parse(decoder.decode(plaintext));
  check(exactKeys(decoded, ["type", "payload"]), "invalid decrypted operation");
  const operation = { listId, id: envelope.id, revision: opaque.revision,
    type: decoded.type, payload: decoded.payload };
  validateOperation(operation);
  return operation;
}

/**
 * Integration adapter for v2/sync.mjs. Real caller supplies trusted member
 * authorization/epoch secret lookups and the IndexedDB sealed-envelope loader.
 */
export function createSyncSecurity({ db, loadSealedMutation, resolveMember, resolveListSecret }) {
  check(typeof loadSealedMutation === "function", "missing durable outbox loader");
  return {
    decodeAndVerify: (listId, opaque) =>
      openMutation({ listId, opaque, resolveMember, resolveListSecret }),
    loadSealed: (listId, mutationId) =>
      loadSealedMutation(db, listId, mutationId),
  };
}
