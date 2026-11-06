// Prototype registry designed to run *inside one Cloudflare Durable Object per
// list*, using its storage.transaction API. NOT wired into the v1 Worker.
// No crypto/list keys or QR decryption seeds may enter this module.

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const TTL = 600_000;
const te = new TextEncoder();
const check = (ok, msg) => { if (!ok) throw new TypeError(msg); };
const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
const fields = (v, ks) => record(v) && Object.keys(v).sort().join(",") === ks.slice().sort().join(",");
const validId = s => typeof s === "string" && ID.test(s);
const validEpoch = n => Number.isSafeInteger(n) && n > 0;
const validTime = n => Number.isSafeInteger(n) && n >= 0;
const validB64 = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max && B64.test(s);
const signatureFields = ["v","listId","inviteId","ownerId","epoch","expiresAt","tokenHash","fingerprint","nonce","ciphertext","ownerPublicJwk","signature"];
const unsigned = r => ({ v: r.v, listId: r.listId, inviteId: r.inviteId, ownerId: r.ownerId,
  epoch: r.epoch, expiresAt: r.expiresAt, tokenHash: r.tokenHash, fingerprint: r.fingerprint,
  nonce: r.nonce, ciphertext: r.ciphertext });
function b64data(s) {
  check(validB64(s, 8192), "invalid encoded value");
  const u = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  check(b64(u) === s, "noncanonical encoding");
  return u;
}
function b64(u) {
  let s = "";
  for (let i = 0; i < u.length; i += 4096) s += String.fromCharCode(...u.subarray(i, i + 4096));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
const keyShape = k => record(k) && k.kty === "EC" && k.crv === "P-256" &&
  validB64(k.x, 50) && validB64(k.y, 50) &&
  b64data(k.x).length === 32 && b64data(k.y).length === 32;
const jwkXY = k => ({kty:"EC",crv:"P-256",x:k.x,y:k.y});
const samePublicKey = (a,b) => jwkXY(a).x === jwkXY(b).x &&
  jwkXY(a).y === jwkXY(b).y;
const fingerprint = async k =>
  b64(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(JSON.stringify(jwkXY(k))))));
async function publicKey(k) {
  check(keyShape(k), "invalid P-256 public key");
  return crypto.subtle.importKey("jwk", jwkXY(k), { name: "ECDSA", namedCurve: "P-256" },
    false, ["verify"]);
}
async function signed(k, signature, message) {
  if (!validB64(signature, 128)) return false;
  const sig = b64data(signature);
  if (sig.length !== 64) return false;
  return crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"}, await publicKey(k), sig, te.encode(message));
}
function validatePackage(r, now) {
  check(fields(r, signatureFields) && r.v === 1 && validId(r.listId) &&
    validId(r.inviteId) && validId(r.ownerId) && validEpoch(r.epoch) &&
    validTime(r.expiresAt) && r.expiresAt > now &&
    r.expiresAt <= now + TTL && validB64(r.tokenHash, 50) &&
    b64data(r.tokenHash).length === 32 && validB64(r.fingerprint, 50) &&
    b64data(r.fingerprint).length === 32 &&
    validB64(r.nonce, 32) && b64data(r.nonce).length === 12 &&
    validB64(r.ciphertext, 8192) && b64data(r.ciphertext).length <= 6144 &&
    keyShape(r.ownerPublicJwk) && validB64(r.signature, 128),
    "invalid or expired owner invitation package");
}
// Signing-key proof authenticates the separate ECDH public key. ECDH PRIVATE
// key possession still needs a challenge/confirmation before activation.
function proofPayload({listId,inviteId,memberId,nonce,tokenHash,agreementPublicJwk}) {
  check(keyShape(agreementPublicJwk), "invalid recipient agreement public key");
  return JSON.stringify({v:2,purpose:"panier-v2-qr-enroll+ecdh",
    listId,inviteId,memberId,nonce,tokenHash,
    agreementPublicJwk:jwkXY(agreementPublicJwk)});
}
function key(name, id) { return name + ":" + id; }

/**
 * Every list MUST have its own Durable Object storage namespace.
 * authOwner({listId, ownerId, epoch, ownerPublicJwk}) MUST verify against
 * the authoritative (signed) current owner membership/epoch, not the request.
 * Without that adapter, createInvitation always fails closed.
 * authorizeEnrollment({tx,listId,ownerId,epoch,inviteId,memberId}) MUST check
 * the same object's current signed owner/membership epoch INSIDE the consume
 * transaction. If absent, redemption fails closed.
 * registerMember may append the signed owner-grant/recipient-proof evidence
 * to a ledger within the SAME transaction; it must not do external I/O.
 *
 * The atomic transaction consumes a token and writes the member record in
 * one commit. Concurrent calls to the same DO are serialised by DO storage.
 */
export class QrInvitationRegistry {
  constructor({storage, authOwner, authorizeEnrollment, registerMember, now = () => Date.now()}) {
    check(storage && typeof storage.transaction === "function", "requires Durable Object storage");
    check(typeof now === "function", "invalid clock");
    this.storage = storage; this.authOwner = authOwner;
    this.authorizeEnrollment = authorizeEnrollment;
    this.registerMember = registerMember; this.now = now;
  }

  async createInvitation(serverRecord) {
    const now = this.now();
    validatePackage(serverRecord, now);
    const matching = await fingerprint(serverRecord.ownerPublicJwk);
    check(matching === serverRecord.fingerprint, "owner public-key fingerprint mismatch");
    const body = unsigned(serverRecord);
    check(await signed(serverRecord.ownerPublicJwk, serverRecord.signature,
      JSON.stringify(body)), "invalid owner signature");
    check(typeof this.authOwner === "function" &&
      await this.authOwner({ listId: serverRecord.listId, ownerId: serverRecord.ownerId,
        epoch: serverRecord.epoch, ownerPublicJwk: serverRecord.ownerPublicJwk }),
      "owner authorization unavailable or denied");
    const { inviteId, listId, ownerId, epoch, expiresAt, tokenHash } = serverRecord;
    return this.storage.transaction(async tx => {
      // Recheck under the SAME transaction that inserts the grant; a role or
      // epoch change between signature verification and this write must fail.
      check(await this.authOwner({tx,listId,ownerId,epoch,
        ownerPublicJwk:serverRecord.ownerPublicJwk}),
        "owner authorization changed before invitation registration");
      const prior = await tx.get(key("invite", inviteId));
      check(!prior, "invitation ID already registered");
      await tx.put(key("invite", inviteId), { listId, ownerId, epoch,
        expiresAt, tokenHash, status: "open", serverRecord });
      return { inviteId, expiresAt };
    });
  }

  async revokeInvitation({listId, inviteId, ownerId, epoch, ownerPublicJwk, proof}) {
    check(validId(listId) && validId(inviteId) && validId(ownerId) &&
      validEpoch(epoch), "invalid revocation");
    // The owner's public key is PUBLIC. Merely sending it does not establish
    // ownership; require proof of possession before cancelling anything.
    check(await signed(ownerPublicJwk, proof, revocationStatement({
      listId, inviteId, ownerId, epoch,
    })), "owner revocation signature invalid");
    check(typeof this.authOwner === "function" &&
      await this.authOwner({listId, ownerId, epoch, ownerPublicJwk}),
      "owner authorization unavailable or denied");
    return this.storage.transaction(async tx => {
      const saved = await tx.get(key("invite", inviteId));
      check(saved && saved.listId === listId && saved.ownerId === ownerId,
        "invitation unavailable");
      check(await this.authOwner({tx,listId,ownerId,epoch,ownerPublicJwk}),
        "owner authorization changed before revocation");
      if (saved.status !== "open") return {status: saved.status};
      saved.status = "revoked";
      await tx.put(key("invite",inviteId), saved);
      return {status:"revoked"};
    });
  }

  /**
   * No server-visible decryption seed. Token is HKDF-derived independently
   * from QR secret; its hash must match the registered commitment.
   * The recipient signs a deterministic enrollment statement with a fresh
   * signing key. This proves possession, NOT personal identity or proximity.
   */
  async redeem({listId, inviteId, token, memberId, memberPublicJwk,
    agreementPublicJwk, nonce, proof}) {
    check(validId(listId) && validId(inviteId) && validId(memberId) &&
      validB64(token, 50) && b64data(token).length === 32 &&
      validB64(nonce, 64) && b64data(nonce).length >= 16 &&
      keyShape(memberPublicJwk) && keyShape(agreementPublicJwk) &&
      !samePublicKey(memberPublicJwk, agreementPublicJwk),
      "invalid enrollment request");
    const tokenHash = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", b64data(token))));
    check(await signed(memberPublicJwk, proof, proofPayload({
      listId, inviteId, memberId, nonce, tokenHash, agreementPublicJwk,
    })), "recipient proof of possession failed");
    const now = this.now();
    return this.storage.transaction(async tx => {
      const saved = await tx.get(key("invite", inviteId));
      check(saved && saved.listId === listId && saved.status === "open" &&
        saved.expiresAt > now && saved.tokenHash === tokenHash,
        "invitation unavailable, expired, consumed or invalid");
      // Same DO transaction must check current owner membership, unchanged
      // list epoch, and invitation issuance authority. Do not trust stale
      // authentication from invitation creation or a separate remote read.
      check(typeof this.authorizeEnrollment === "function" &&
        await this.authorizeEnrollment({tx, listId, ownerId: saved.ownerId,
          epoch: saved.epoch, inviteId, memberId}),
        "current membership or epoch authorization unavailable");
      check(!await tx.get(key("member", memberId)), "member ID already exists");
      // Both effects must be in the SAME durable transaction. This is the
      // single-use enforcement point; concurrent redemption cannot both win.
      if (this.registerMember) {
        // The signed-invitation/recipient-proof ledger event must be appended
        // atomically with member registration and invite consumption.
        await this.registerMember({tx,listId,inviteId,memberId,
          memberPublicJwk,agreementPublicJwk,nonce,proof,
          serverRecord:saved.serverRecord});
      }
      await tx.put(key("member", memberId), {
        memberId, listId, publicJwk: jwkXY(memberPublicJwk),
        agreementPublicJwk: jwkXY(agreementPublicJwk),
        invitedBy: saved.ownerId, invitationId: inviteId, epoch: saved.epoch,
      });
      saved.status = "used";
      saved.memberId = memberId;
      await tx.put(key("invite", inviteId), saved);
      return {listId, inviteId, memberId, epoch: saved.epoch,
        serverRecord: saved.serverRecord};
    });
  }
}

// Exported only to make client-side proof formatting interoperable in tests.
// This statement must eventually be frozen as a reviewed canonical wire format.
export function enrollmentStatement(details) {
  return proofPayload(details);
}

// Canonical owner-signed cancellation statement (one-way and replay-safe).
// Old-epoch attempts are additionally rejected by current ledger authority.
export function revocationStatement({listId,inviteId,ownerId,epoch}) {
  return JSON.stringify({v:1,purpose:"panier-v2-qr-revoke",
    listId,inviteId,ownerId,epoch});
}
