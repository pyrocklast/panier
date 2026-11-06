// Panier v2 — experimental authenticated receipt for a post-revocation
// key package. No Worker, server, local persistence or network dependencies.
// A valid receipt proves that a *registered signing key* acknowledged the
// exact package and demonstrated knowledge of the new epoch secret.
// It does NOT establish server freshness, delivery to offline members, or
// unconditional proof of ECDH private-key possession.

import { openRotatedKeyPackage } from "./rekey.mjs";
import { importMemberPublicKey } from "./crypto.mjs";

const te = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const check = (value, message) => { if (!value) throw new TypeError(message); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const validId = value => typeof value === "string" && ID.test(value);
const encoded = value => te.encode(JSON.stringify(value));

function base64url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 4096)
    binary += String.fromCharCode(...bytes.subarray(index, index + 4096));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode64(value, byteLength) {
  check(typeof value === "string" && value.length > 0 &&
    value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value), "invalid receipt encoding");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    char => char.charCodeAt(0));
  check(bytes.length === byteLength && base64url(bytes) === value,
    "invalid receipt encoding");
  return bytes;
}
const sameKey = (a, b) => object(a) && object(b) &&
  a.kty === "EC" && b.kty === "EC" &&
  a.crv === "P-256" && b.crv === "P-256" &&
  a.x === b.x && a.y === b.y;

function authenticatedMember(verifiedMembership, memberId, envelope) {
  check(object(verifiedMembership) && object(envelope) &&
    verifiedMembership.listId === envelope.listId &&
    verifiedMembership.epoch === envelope.epoch &&
    verifiedMembership.head === envelope.rotationHead &&
    verifiedMembership.ownerId === envelope.ownerId &&
    validId(memberId) && Array.isArray(verifiedMembership.members),
    "membership checkpoint does not match key package");
  const member = verifiedMembership.members.find(value => value.memberId === memberId);
  check(member && member.active === true && member.role === "member" &&
    object(member.publicJwk) && object(member.agreementPublicJwk) &&
    envelope.memberId === memberId,
    "recipient is not an authorized, registered member");
  return member;
}

async function fingerprint(envelope) {
  check(exact(envelope, ["v", "listId", "epoch", "rotationHead", "ownerId",
    "memberId", "ephemeralPublicJwk", "nonce", "ciphertext", "signature"]) &&
    envelope.v === 1, "invalid signed key package");
  return base64url(await crypto.subtle.digest("SHA-256", encoded(envelope)));
}

function receiptStatement({listId, epoch, rotationHead, ownerId, memberId, packageHash}) {
  return {v:1,purpose:"panier/v2/rekey/receipt/1",
    listId,epoch,rotationHead,ownerId,memberId,packageHash};
}
async function receiptKey(listSecret, statement) {
  check(listSecret instanceof Uint8Array && listSecret.length === 32,
    "invalid epoch secret for confirmation");
  const root = await crypto.subtle.importKey("raw", listSecret, "HKDF", false,
    ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name:"HKDF", hash:"SHA-256",
    salt:te.encode("panier/v2/rekey/receipt:"+statement.listId+":"+statement.epoch),
    info:encoded(statement),
  }, root, {name:"HMAC",hash:"SHA-256",length:256}, false, ["sign", "verify"]);
}
async function knowledgeProof(listSecret, statement) {
  const key = await receiptKey(listSecret, statement);
  return base64url(await crypto.subtle.sign("HMAC", key,
    te.encode("panier/v2/rekey/receipt/proof/1")));
}
function signedStatement(statement, proof) {
  return {...statement, proof};
}

/**
 * Decrypts a previously owner-signed envelope with the device's ECDH key,
 * then signs a transcript proving knowledge of the decrypted epoch secret.
 *
 * The caller MUST first validate the membership history from a pinned owner
 * root and require a sufficiently fresh/checkpointed head. This function
 * compares the caller-supplied verified snapshot but does not verify the
 * ledger's cryptographic history itself.
 */
export async function receiveAndConfirmRekey({
  envelope, verifiedMembership, recipientAgreementPrivateKey,
  recipientSigningPrivateKey, trustedOwnerSigningKey,
}) {
  const member = authenticatedMember(verifiedMembership, envelope?.memberId, envelope);
  check(recipientSigningPrivateKey instanceof CryptoKey &&
    recipientSigningPrivateKey.type === "private" &&
    recipientSigningPrivateKey.algorithm.name === "ECDSA" &&
    recipientSigningPrivateKey.algorithm.namedCurve === "P-256",
    "invalid recipient signing key");
  const secret = await openRotatedKeyPackage({
    envelope,listId:envelope.listId,memberId:envelope.memberId,
    currentEpoch:verifiedMembership.epoch,
    rotationHead:verifiedMembership.head,trustedOwnerSigningKey,
    recipientAgreementPrivateKey,
  });
  const statement = receiptStatement({...envelope, packageHash:await fingerprint(envelope)});
  const proof = await knowledgeProof(secret, statement);
  const signed = signedStatement(statement, proof);
  const signature = base64url(await crypto.subtle.sign(
    {name:"ECDSA",hash:"SHA-256"},recipientSigningPrivateKey,encoded(signed)));
  // Verify immediately against the membership-pinned signing identity,
  // preventing local mismatches between stored signing and ECDH identities.
  const publicKey = await importMemberPublicKey(member.publicJwk);
  check(await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},
    publicKey,decode64(signature,64),encoded(signed)),
    "recipient signature does not match registered member");
  return {listSecret:secret,receipt:{...signed,signature}};
}

/**
 * Owner verifies proof of knowledge AND member signature. The server can
 * store/forward the receipt but cannot authenticate the HMAC without the
 * fresh list secret; it cannot mark delivery as confirmed on its own.
 */
export async function verifyRekeyReceipt({
  receipt,envelope,verifiedMembership,ownerListSecret,
}) {
  check(exact(receipt,["v","purpose","listId","epoch","rotationHead",
    "ownerId","memberId","packageHash","proof","signature"]),
    "invalid rekey receipt");
  const member = authenticatedMember(verifiedMembership,receipt.memberId,envelope);
  const expected = receiptStatement({...envelope,
    packageHash:await fingerprint(envelope)});
  check(receipt.v === expected.v && receipt.purpose === expected.purpose &&
    receipt.listId === expected.listId && receipt.epoch === expected.epoch &&
    receipt.rotationHead === expected.rotationHead &&
    receipt.ownerId === expected.ownerId && receipt.memberId === expected.memberId &&
    receipt.packageHash === expected.packageHash,
    "receipt does not match exact key package and membership head");
  const signed = signedStatement(expected,receipt.proof);
  const publicKey = await importMemberPublicKey(member.publicJwk);
  check(await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},publicKey,
    decode64(receipt.signature,64),encoded(signed)),
    "invalid recipient receipt signature");
  // Web Crypto HMAC verification checks the exact tag without a
  // handwritten secret-dependent byte comparison.
  const providedBytes=decode64(receipt.proof,32);
  const key=await receiptKey(ownerListSecret,expected);
  check(await crypto.subtle.verify("HMAC",key,providedBytes,
    te.encode("panier/v2/rekey/receipt/proof/1")),
    "invalid decrypted key confirmation");
  return {listId:expected.listId,epoch:expected.epoch,
    rotationHead:expected.rotationHead,memberId:expected.memberId,
    packageHash:expected.packageHash,confirmed:true};
}
