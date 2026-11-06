// Panier v2 in-person QR key-package prototype. NOT membership enrollment.
// The QR is a bearer decryption capability even after server-side redemption.
// No URL sharing, server endpoints, QR rendering, storage or production use.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const QR_PREFIX = "panier-v2-qr.";
const MAX_QR_LENGTH = 1024;
const MAX_PACKAGE_JSON = 8192;
export const QR_TTL_MS = 10 * 60 * 1000;

const validId = v => typeof v === "string" && ID.test(v);
const validEpoch = v => Number.isSafeInteger(v) && v >= 1;
const validTime = v => Number.isSafeInteger(v) && v >= 0;
const isRecord = v => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (value, keys) => isRecord(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
function requireThat(condition, message) {
  if (!condition) throw new TypeError(message);
}
function cryptoApi() {
  requireThat(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues, "Web Crypto unavailable");
  return crypto.subtle;
}
function b64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < u.length; i += 8192) binary += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function unb64(text, max = 2048) {
  requireThat(typeof text === "string" && text.length > 0 &&
    text.length <= max && /^[a-zA-Z0-9_-]+$/.test(text), "invalid encoded secret");
  const decoded = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  requireThat(b64(decoded) === text, "noncanonical encoding");
  return decoded;
}
const encode = obj => b64(encoder.encode(JSON.stringify(obj)));
function parseEncoded(text, limit) {
  const source = decoder.decode(unb64(text, limit));
  const result = JSON.parse(source);
  requireThat(isRecord(result) && JSON.stringify(result) === source, "invalid encoded JSON");
  return result;
}

function ownerJwk(jwk) {
  requireThat(isRecord(jwk) && jwk.kty === "EC" && jwk.crv === "P-256" &&
    typeof jwk.x === "string" && typeof jwk.y === "string" &&
    unb64(jwk.x, 128).length === 32 && unb64(jwk.y, 128).length === 32,
    "invalid owner signing key");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}
async function ownerFingerprint(jwk) {
  return b64(await cryptoApi().digest("SHA-256", encoder.encode(JSON.stringify(ownerJwk(jwk)))));
}
async function derive(master, listId, inviteId, purpose) {
  const subtle = cryptoApi();
  const key = await subtle.importKey("raw", master, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({
    name: "HKDF", hash: "SHA-256",
    salt: encoder.encode("panier/v2/qr:" + listId + ":" + inviteId),
    info: encoder.encode("panier/v2/qr/" + purpose + "/1"),
  }, key, 256));
}
async function encryptionKey(master, listId, inviteId) {
  const material = await derive(master, listId, inviteId, "key");
  return cryptoApi().importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function redemptionToken(master, listId, inviteId) {
  return b64(await derive(master, listId, inviteId, "redeem"));
}
async function tokenCommitment(token) {
  return b64(await cryptoApi().digest("SHA-256", unb64(token, 64)));
}
function header({ listId, inviteId, ownerId, epoch, expiresAt, tokenHash, fingerprint }) {
  return { v: 1, listId, inviteId, ownerId, epoch, expiresAt, tokenHash, fingerprint };
}
function signedBody(h, nonce, ciphertext) {
  return { ...h, nonce, ciphertext };
}
function validateQr(qr) {
  requireThat(typeof qr === "string" && qr.length <= MAX_QR_LENGTH &&
    qr.startsWith(QR_PREFIX), "not a Panier v2 invitation QR");
  const payload = parseEncoded(qr.slice(QR_PREFIX.length), MAX_QR_LENGTH);
  requireThat(exact(payload, ["v", "listId", "inviteId", "expiresAt", "fingerprint", "secret"]) &&
    payload.v === 1 && validId(payload.listId) && validId(payload.inviteId) &&
    validTime(payload.expiresAt) && unb64(payload.secret, 64).length === 32 &&
    unb64(payload.fingerprint, 64).length === 32,
    "invalid QR payload");
  return payload;
}

/**
 * Owner prepares a signed, AES-GCM-encrypted list-key package in advance.
 * The owner MUST authenticate a server-side create-invitation request separately.
 * Register serverRecord BEFORE displaying the QR; no remote share controls.
 */
export async function prepareQrInvitation({
  listId, ownerId, epoch, listSecret, ownerPrivateKey, ownerPublicJwk,
  now = Date.now(), ttlMs = QR_TTL_MS,
}) {
  requireThat(validId(listId) && validId(ownerId) && validEpoch(epoch) &&
    listSecret instanceof Uint8Array && listSecret.length === 32 &&
    validTime(now) && Number.isSafeInteger(ttlMs) && ttlMs >= 1000 &&
    ttlMs <= QR_TTL_MS && Number.isSafeInteger(now + ttlMs),
    "invalid invitation context");
  requireThat(ownerPrivateKey instanceof CryptoKey &&
    ownerPrivateKey.type === "private" &&
    ownerPrivateKey.algorithm.name === "ECDSA" &&
    ownerPrivateKey.algorithm.namedCurve === "P-256", "invalid owner signing key");
  const fingerprint = await ownerFingerprint(ownerPublicJwk);
  const inviteId = crypto.randomUUID();
  const master = crypto.getRandomValues(new Uint8Array(32));
  const token = await redemptionToken(master, listId, inviteId);
  const expiresAt = now + ttlMs;
  const h = header({
    listId, inviteId, ownerId, epoch, expiresAt,
    tokenHash: await tokenCommitment(token), fingerprint,
  });
  const payload = { v: 1, listId, epoch, key: b64(listSecret) };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(master, listId, inviteId);
  const ciphertext = b64(await cryptoApi().encrypt({
    name: "AES-GCM", iv: nonce, additionalData: encoder.encode(JSON.stringify(h)),
    tagLength: 128,
  }, key, encoder.encode(JSON.stringify(payload))));
  const body = signedBody(h, b64(nonce), ciphertext);
  const signature = b64(await cryptoApi().sign(
    { name: "ECDSA", hash: "SHA-256" }, ownerPrivateKey,
    encoder.encode(JSON.stringify(body))));
  const serverRecord = {
    ...body, ownerPublicJwk: ownerJwk(ownerPublicJwk), signature,
  };
  const qr = QR_PREFIX + encode({
    v: 1, listId, inviteId, expiresAt, fingerprint, secret: b64(master),
  });
  requireThat(qr.length <= MAX_QR_LENGTH &&
    JSON.stringify(serverRecord).length <= MAX_PACKAGE_JSON, "invitation too large");
  return { qr, serverRecord };
}

/**
 * Derive the redemption token from the scanned QR without uploading the
 * separate decryption seed. A server MUST atomically verify hash(token),
 * expiry, authorization and first-use registration. This only prepares input.
 */
export async function prepareQrRedemption(qr, now = Date.now()) {
  const parsed = validateQr(qr);
  requireThat(validTime(now) && now < parsed.expiresAt, "invitation expired");
  return {
    listId: parsed.listId, inviteId: parsed.inviteId,
    token: await redemptionToken(unb64(parsed.secret, 64), parsed.listId, parsed.inviteId),
  };
}

/**
 * Verify owner-signed package, QR fingerprint and context before decrypting.
 * NOTE: This does NOT perform server-side single-use redemption or register
 * the recipient identity; it is only confidential client-side key transfer.
 */
export async function openQrKeyPackage({ qr, serverRecord, now = Date.now() }) {
  const q = validateQr(qr);
  requireThat(validTime(now) && now < q.expiresAt, "invitation expired");
  requireThat(exact(serverRecord, [
    "v", "listId", "inviteId", "ownerId", "epoch", "expiresAt", "tokenHash",
    "fingerprint", "nonce", "ciphertext", "ownerPublicJwk", "signature",
  ]) && serverRecord.v === 1 && serverRecord.listId === q.listId &&
    serverRecord.inviteId === q.inviteId && serverRecord.expiresAt === q.expiresAt &&
    validId(serverRecord.ownerId) && validEpoch(serverRecord.epoch) &&
    serverRecord.fingerprint === q.fingerprint,
    "invalid invitation package");
  const master = unb64(q.secret, 64);
  const token = await redemptionToken(master, q.listId, q.inviteId);
  requireThat(serverRecord.tokenHash === await tokenCommitment(token),
    "redemption capability mismatch");
  requireThat(await ownerFingerprint(serverRecord.ownerPublicJwk) === q.fingerprint,
    "owner fingerprint mismatch");
  const h = header(serverRecord);
  const body = signedBody(h, serverRecord.nonce, serverRecord.ciphertext);
  const ownerKey = await cryptoApi().importKey("jwk", ownerJwk(serverRecord.ownerPublicJwk),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signature = unb64(serverRecord.signature, 128);
  requireThat(signature.length === 64 &&
    await cryptoApi().verify({ name: "ECDSA", hash: "SHA-256" },
      ownerKey, signature, encoder.encode(JSON.stringify(body))),
    "invalid owner signature");
  const nonce = unb64(serverRecord.nonce, 64);
  requireThat(nonce.length === 12, "invalid nonce");
  const encrypted = unb64(serverRecord.ciphertext, MAX_PACKAGE_JSON);
  const key = await encryptionKey(master, q.listId, q.inviteId);
  const plain = await cryptoApi().decrypt({
    name: "AES-GCM", iv: nonce,
    additionalData: encoder.encode(JSON.stringify(h)), tagLength: 128,
  }, key, encrypted);
  const payload = JSON.parse(decoder.decode(plain));
  requireThat(exact(payload, ["v", "listId", "epoch", "key"]) &&
    payload.v === 1 && payload.listId === q.listId &&
    payload.epoch === serverRecord.epoch, "key package metadata mismatch");
  const listSecret = unb64(payload.key, 64);
  requireThat(listSecret.length === 32, "invalid list secret");
  return {
    listId: q.listId, inviteId: q.inviteId, ownerId: serverRecord.ownerId,
    epoch: payload.epoch, listSecret,
  };
}
