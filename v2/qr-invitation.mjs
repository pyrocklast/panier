// Panier v2 QR pairing *package* prototype, no server/UI/QR renderer.
// Owner prepares authenticated ciphertext while present; QR bears the two
// secrets. Redemption must be performed atomically by a separate backend.
// This is NOT production security-approved, see v2/QR-PAIRING.md.

const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const idPattern = /^[A-Za-z0-9_-]{8,64}$/;
const isId = x => typeof x === "string" && idPattern.test(x);
const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const assert = (ok, message) => { if (!ok) throw new TypeError(message); };
const exact = (value, keys) => isObj(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const b64 = input => {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  let text = "";
  for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const unb64 = (text, limit = 4096) => {
  assert(typeof text === "string" && text.length > 0 && text.length <= limit &&
    /^[A-Za-z0-9_-]+$/.test(text), "invalid base64url field");
  const data = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  assert(b64(data) === text, "noncanonical base64url");
  return data;
};
const canonical = obj => JSON.stringify(obj);
const encode = obj => utf8.encode(canonical(obj));
const digest = async data => b64(await crypto.subtle.digest("SHA-256", data));
const random = n => crypto.getRandomValues(new Uint8Array(n));
const positiveTime = n => Number.isSafeInteger(n) && n > 0;
const supportedKey = key => key instanceof CryptoKey && key.algorithm.name === "ECDSA" &&
  key.algorithm.namedCurve === "P-256";
const signatureKey = key => supportedKey(key) && key.type === "private" && key.usages.includes("sign");
const verifierKey = key => supportedKey(key) && key.type === "public" && key.usages.includes("verify");
const publicFormat = jwk => isObj(jwk) && jwk.kty === "EC" && jwk.crv === "P-256" &&
  typeof jwk.x === "string" && typeof jwk.y === "string";

// QR payload is a private bearer capability; NEVER publish its full content.
export const QR_PREFIX = "panier-v2-join:";
const TAG = "panier/v2/qr/key-package/1";
const MAX_AGE_MS = 10 * 60 * 1000;

function validateQr(qr) {
  assert(exact(qr, ["v", "invitationId", "listId", "key", "redeem", "ownerFingerprint"]) &&
    qr.v === 1 && isId(qr.invitationId) && isId(qr.listId), "invalid QR payload");
  assert(unb64(qr.key, 100).length === 32 && unb64(qr.redeem, 100).length === 32,
    "invalid QR secret lengths");
  assert(unb64(qr.ownerFingerprint, 100).length === 32, "invalid owner fingerprint");
  return qr;
}

export function parseInvitationQr(qrText) {
  assert(typeof qrText === "string" && qrText.startsWith(QR_PREFIX) &&
    qrText.length <= 600, "invalid QR text");
  const decoded = decoder.decode(unb64(qrText.slice(QR_PREFIX.length), 600));
  const qr = JSON.parse(decoded);
  assert(canonical(qr) === decoded, "noncanonical QR payload");
  validateQr(qr);
  assert(decoded === canonical({
    v: qr.v, invitationId: qr.invitationId, listId: qr.listId,
    key: qr.key, redeem: qr.redeem, ownerFingerprint: qr.ownerFingerprint,
  }), "noncanonical QR field order");
  return qr;
}

// The QR does not include the owner public JWK. Fetch it alongside the
// signed ciphertext from the untrusted server, then bind it to this fingerprint.
async function fingerprint(publicKey) {
  assert(verifierKey(publicKey), "invalid owner public key");
  return digest(await crypto.subtle.exportKey("spki", publicKey));
}

function packageHeader({ listId, invitationId, issuerId, epoch, expiresAt, commitment }) {
  return { v: 1, listId, invitationId, issuerId, epoch, expiresAt, commitment };
}

/**
 * Prepare a full key package BEFORE generating/rendering the QR. The owner
 * must upload the server record using existing owner authentication.
 *
 * SERVER RECORD: {listId, invitationId, expiresAt, commitment, package:
 * {header,nonce,ciphertext,signature,ownerPublicJwk}}
 * QR TEXT: a short-lived, in-person bearer string containing key + redeem
 * secrets; it must never be sent to the server or logged.
 */
export async function prepareQrInvitation({
  listId, epoch, listSecret, issuerId, ownerPrivateKey, ownerPublicKey,
  now = Date.now(), lifetimeMs = MAX_AGE_MS,
}) {
  assert(globalThis.crypto?.subtle && crypto.getRandomValues, "Web Crypto required");
  assert(isId(listId) && isId(issuerId) && Number.isSafeInteger(epoch) && epoch > 0,
    "invalid list/issuer context");
  assert(listSecret instanceof Uint8Array && listSecret.length === 32,
    "invalid list secret");
  assert(signatureKey(ownerPrivateKey) && verifierKey(ownerPublicKey),
    "invalid owner signing identity");
  assert(positiveTime(now) && Number.isSafeInteger(lifetimeMs) &&
    lifetimeMs > 0 && lifetimeMs <= MAX_AGE_MS &&
    Number.isSafeInteger(now + lifetimeMs), "invalid invitation expiration");
  const invitationId = crypto.randomUUID();
  const key = random(32), redeem = random(32), nonce = random(12);
  const commitment = await digest(encode({ domain: TAG, listId, invitationId, redeem: b64(redeem) }));
  const header = packageHeader({
    listId, invitationId, issuerId, epoch,
    expiresAt: now + lifetimeMs, commitment,
  });
  const plaintext = encode({ listId, epoch, key: b64(listSecret) });
  const transferKey = await crypto.subtle.importKey("raw", key,
    { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = b64(await crypto.subtle.encrypt({
    name: "AES-GCM", iv: nonce, additionalData: encode(header), tagLength: 128,
  }, transferKey, plaintext));
  const unsigned = { header, nonce: b64(nonce), ciphertext };
  const signature = b64(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, ownerPrivateKey, encode(unsigned)));
  const ownerPublicJwk = await crypto.subtle.exportKey("jwk", ownerPublicKey);
  const record = { ...unsigned, signature, ownerPublicJwk };
  const qr = {
    v: 1, invitationId, listId,
    key: b64(key), redeem: b64(redeem),
    ownerFingerprint: await fingerprint(ownerPublicKey),
  };
  const qrText = QR_PREFIX + b64(encode(qr));
  assert(qrText.length <= 600, "QR payload too long");
  return { qrText, record, serverMetadata: {
    listId, invitationId, expiresAt: header.expiresAt, commitment,
  } };
}

/** Derive a one-way commitment to submit when claiming an invitation. */
export async function deriveRedemption(qrText) {
  const qr = parseInvitationQr(qrText);
  return {
    listId: qr.listId, invitationId: qr.invitationId,
    redeemToken: qr.redeem,
  };
}

/**
 * Unwrap the owner-prepared key package. Requires an independently recorded
 * SUCCESSFUL, server-authorized single-use claim tied to recipient credentials.
 * This method alone does NOT prove/perform membership registration.
 * The caller must not persist key material until the server claim is confirmed.
 */
export async function openQrInvitation({
  qrText, record, now = Date.now(), claimConfirmed = false,
}) {
  const qr = parseInvitationQr(qrText);
  assert(claimConfirmed === true, "server membership claim not confirmed");
  assert(positiveTime(now), "invalid clock");
  assert(exact(record, ["header", "nonce", "ciphertext", "signature", "ownerPublicJwk"]) &&
    publicFormat(record.ownerPublicJwk), "invalid invitation record");
  // Require the specified wire ordering, not merely valid JSON. This avoids
  // multiple serialized representations of the same signed package.
  assert(canonical(record) === canonical({
    header: record.header, nonce: record.nonce,
    ciphertext: record.ciphertext, signature: record.signature,
    ownerPublicJwk: record.ownerPublicJwk,
  }), "noncanonical invitation record");
  const h = record.header;
  assert(exact(h, ["v", "listId", "invitationId", "issuerId", "epoch", "expiresAt", "commitment"]) &&
    h.v === 1 && h.listId === qr.listId && h.invitationId === qr.invitationId &&
    isId(h.issuerId) && Number.isSafeInteger(h.epoch) && h.epoch > 0 &&
    positiveTime(h.expiresAt) && now <= h.expiresAt, "invalid or expired invitation");
  const expectedCommitment = await digest(encode({
    domain: TAG, listId: qr.listId, invitationId: qr.invitationId, redeem: qr.redeem,
  }));
  assert(h.commitment === expectedCommitment, "redemption secret mismatch");
  const ownerKey = await crypto.subtle.importKey("jwk", record.ownerPublicJwk,
    { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  assert(await fingerprint(ownerKey) === qr.ownerFingerprint,
    "owner identity fingerprint mismatch");
  const unsigned = { header: h, nonce: record.nonce, ciphertext: record.ciphertext };
  const signature = unb64(record.signature, 256);
  assert(signature.length === 64 && await crypto.subtle.verify({
    name: "ECDSA", hash: "SHA-256",
  }, ownerKey, signature, encode(unsigned)), "invalid owner signature");
  const nonce = unb64(record.nonce, 64);
  assert(nonce.length === 12, "invalid invitation nonce");
  const key = unb64(qr.key, 100);
  const transferKey = await crypto.subtle.importKey("raw", key,
    { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: nonce, additionalData: encode(h), tagLength: 128,
  }, transferKey, unb64(record.ciphertext, 4096));
  const data = JSON.parse(decoder.decode(plaintext));
  assert(exact(data, ["listId", "epoch", "key"]) &&
    data.listId === qr.listId && data.epoch === h.epoch, "key package binding mismatch");
  const listSecret = unb64(data.key, 100);
  assert(listSecret.length === 32, "invalid list key");
  return { listId: qr.listId, epoch: h.epoch, listSecret,
    issuerId: h.issuerId, invitationId: qr.invitationId };
}
