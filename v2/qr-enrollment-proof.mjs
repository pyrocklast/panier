// Client proof of possession for an in-person QR invitation.
// Does NOT issue challenges or memberships. Backend must issue/store an
// unpredictable single-use challenge and atomically consume it on enrollment.

const utf8 = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const verifyId = value => typeof value === "string" && ID.test(value);
const assert = (ok, message) => { if (!ok) throw new TypeError(message); };
const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (obj, expect) => isObj(obj) &&
  Object.keys(obj).sort().join(",") === [...expect].sort().join(",");
const encode = value => utf8.encode(JSON.stringify(value));
const b64 = data => {
  let binary = "";
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const raw = text => {
  assert(typeof text === "string" && /^[A-Za-z0-9_-]+$/.test(text) && text.length <= 256,
    "invalid proof encoding");
  const result = Uint8Array.from(atob(text.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
  assert(b64(result) === text, "noncanonical proof");
  return result;
};
const canonicalPublic = jwk => {
  assert(isObj(jwk) && jwk.kty === "EC" && jwk.crv === "P-256",
    "unsupported enrollment identity");
  assert(typeof jwk.x === "string" && raw(jwk.x).length === 32 &&
    typeof jwk.y === "string" && raw(jwk.y).length === 32,
    "invalid enrollment public key");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
};
const transcript = ({listId,invitationId,challenge,actorId,publicKey}) => ({
  domain: "panier/v2/qr-enrollment-proof/1",
  v: 1, listId, invitationId, challenge, actorId, publicKey,
});

/**
 * Produce a signature over the server challenge, recipient public key and
 * invitation context. This proof is valid ONLY if the server issued and
 * atomically consumes that challenge for this invitation.
 */
export async function createEnrollmentProof({
  listId, invitationId, challenge, actorId, privateKey, publicKey,
}) {
  assert(verifyId(listId) && verifyId(invitationId) && verifyId(actorId),
    "invalid enrollment context");
  assert(raw(challenge).length === 32, "challenge must be 32 random bytes");
  assert(privateKey instanceof CryptoKey && privateKey.type === "private" &&
    privateKey.algorithm.name === "ECDSA" && privateKey.algorithm.namedCurve === "P-256",
    "invalid private enrollment key");
  assert(publicKey instanceof CryptoKey && publicKey.type === "public" &&
    publicKey.algorithm.name === "ECDSA" && publicKey.algorithm.namedCurve === "P-256",
    "invalid public enrollment key");
  const jwk = canonicalPublic(await crypto.subtle.exportKey("jwk", publicKey));
  const body = transcript({listId,invitationId,challenge,actorId,publicKey:jwk});
  const sig = await crypto.subtle.sign(
    {name:"ECDSA",hash:"SHA-256"},privateKey,encode(body));
  return {...body, signature:b64(sig)};
}

/**
 * Cryptographic verification ONLY. The server still must check challenge
 * freshness/non-reuse, invitation token commitment, owner authorization,
 * expiry, epoch and membership role in one atomic state transition.
 */
export async function verifyEnrollmentProof({
  proof, expectedListId, expectedInvitationId, expectedChallenge,
}) {
  assert(keys(proof,["domain","v","listId","invitationId","challenge",
      "actorId","publicKey","signature"]) &&
    proof.domain === "panier/v2/qr-enrollment-proof/1" && proof.v === 1 &&
    verifyId(proof.actorId) && proof.listId === expectedListId &&
    proof.invitationId === expectedInvitationId &&
    proof.challenge === expectedChallenge &&
    raw(proof.challenge).length === 32, "invalid enrollment binding");
  const pub = canonicalPublic(proof.publicKey);
  assert(keys(proof.publicKey,["kty","crv","x","y"]), "unexpected enrollment key fields");
  const signature = raw(proof.signature);
  assert(signature.length === 64, "invalid enrollment signature");
  const imported = await crypto.subtle.importKey("jwk", pub,
    {name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  const body = transcript({
    listId:proof.listId, invitationId:proof.invitationId,
    challenge:proof.challenge, actorId:proof.actorId, publicKey:pub,
  });
  return crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},imported,signature,encode(body));
}
