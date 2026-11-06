import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningIdentity } from "../v2/crypto.mjs";
import {
  prepareQrInvitation, prepareQrRedemption, openQrKeyPackage, QR_TTL_MS,
} from "../v2/qr-pairing.mjs";

const LIST = "household01";
const OTHER = "household02";
const NOW = 1_750_000_000_000;
const secret = () => crypto.getRandomValues(new Uint8Array(32));
async function fixture(options = {}) {
  const owner = await generateSigningIdentity();
  const listSecret = secret();
  const created = await prepareQrInvitation({
    listId: LIST, ownerId: owner.actorId, epoch: 1,
    listSecret, ownerPrivateKey: owner.privateKey,
    ownerPublicJwk: owner.publicKeyJwk, now: NOW, ...options,
  });
  return { owner, listSecret, ...created };
}
const copy = x => structuredClone(x);
const editQr = (qr, mutate) => {
  const [prefix, data] = qr.split(".");
  const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  mutate(parsed);
  return prefix + "." + Buffer.from(JSON.stringify(parsed)).toString("base64url");
};
async function rejectBadRecord(f, mutation) {
  const forged = copy(f.serverRecord);
  mutation(forged);
  await assert.rejects(openQrKeyPackage({ qr: f.qr, serverRecord: forged, now: NOW + 100 }));
}

test("in-person QR decrypts owner-authenticated key without sending plaintext to server", async () => {
  const f = await fixture();
  const recovered = await openQrKeyPackage({ qr: f.qr, serverRecord: f.serverRecord, now: NOW + 100 });
  assert.equal(recovered.listId, LIST);
  assert.equal(recovered.ownerId, f.owner.actorId);
  assert.equal(recovered.epoch, 1);
  assert.deepEqual(recovered.listSecret, f.listSecret);
  assert.equal(f.serverRecord.key, undefined);
  assert.equal(JSON.stringify(f.serverRecord).includes(Buffer.from(f.listSecret).toString("base64url")), false);
});

test("redemption token is derived separately from secret; only hash is stored on server", async () => {
  const f = await fixture();
  const prepared = await prepareQrRedemption(f.qr, NOW);
  assert.equal(prepared.listId, LIST);
  assert.equal(prepared.inviteId, f.serverRecord.inviteId);
  assert.equal(prepared.token.length, 43);
  assert.notEqual(prepared.token, f.serverRecord.tokenHash);
  assert.ok(!JSON.stringify(f.serverRecord).includes(prepared.token));
  assert.ok(!JSON.stringify(f.serverRecord).includes(f.qr));
  assert.deepEqual(
    await crypto.subtle.digest("SHA-256", Buffer.from(prepared.token, "base64url")).then(
      buffer => Buffer.from(buffer).toString("base64url")),
    f.serverRecord.tokenHash,
  );
});

test("independent QR codes have unique IDs, secrets, encrypted packages and commitments", async () => {
  const owner = await generateSigningIdentity();
  const config = {
    listId: LIST, ownerId: owner.actorId, epoch: 1,
    listSecret: secret(), ownerPrivateKey: owner.privateKey,
    ownerPublicJwk: owner.publicKeyJwk, now: NOW,
  };
  const a = await prepareQrInvitation(config);
  const b = await prepareQrInvitation(config);
  assert.notEqual(a.qr, b.qr);
  assert.notEqual(a.serverRecord.inviteId, b.serverRecord.inviteId);
  assert.notEqual(a.serverRecord.tokenHash, b.serverRecord.tokenHash);
  assert.notEqual(a.serverRecord.ciphertext, b.serverRecord.ciphertext);
});

test("expired QR is rejected both before redemption and before key opening", async () => {
  const f = await fixture();
  await assert.rejects(prepareQrRedemption(f.qr, NOW + QR_TTL_MS), /expired/);
  await assert.rejects(openQrKeyPackage({
    qr: f.qr, serverRecord: f.serverRecord, now: NOW + QR_TTL_MS,
  }), /expired/);
  await assert.rejects(fixture({ ttlMs: QR_TTL_MS + 1 }), /invalid invitation context/);
});

test("substitution of signing key or fingerprint is rejected", async () => {
  const f = await fixture();
  const foreign = await generateSigningIdentity();
  await rejectBadRecord(f, record => { record.ownerPublicJwk = foreign.publicKeyJwk; });
  await rejectBadRecord(f, record => { record.fingerprint = "A".repeat(43); });
  await assert.rejects(openQrKeyPackage({
    qr: editQr(f.qr, payload => { payload.fingerprint = "A".repeat(43); }),
    serverRecord: f.serverRecord, now: NOW,
  }));
});

test("tampered or swapped ciphertext, signature, metadata or token commitment fails closed", async () => {
  const f = await fixture();
  for (const mutate of [
    r => { r.listId = OTHER; },
    r => { r.epoch = 2; },
    r => { r.expiresAt += 100; },
    r => { r.ownerId = "otherowner01"; },
    r => { r.inviteId = "otherinvite01"; },
    r => { r.tokenHash = "B".repeat(43); },
    r => { r.ciphertext = (r.ciphertext[0] === "A" ? "B" : "A") + r.ciphertext.slice(1); },
    r => { r.signature = (r.signature[0] === "A" ? "B" : "A") + r.signature.slice(1); },
    r => { r.nonce = "AAAAAAAAAAAAAAAA"; },
    r => { r.unexpected = "payload"; },
  ]) await rejectBadRecord(f, mutate);
  const another = await fixture();
  await assert.rejects(openQrKeyPackage({ qr: f.qr, serverRecord: another.serverRecord, now: NOW }));
});

test("changed QR secret or list ID cannot unlock an otherwise valid package", async () => {
  const f = await fixture();
  await assert.rejects(openQrKeyPackage({
    qr: editQr(f.qr, payload => { payload.listId = OTHER; }),
    serverRecord: f.serverRecord, now: NOW,
  }));
  await assert.rejects(openQrKeyPackage({
    qr: editQr(f.qr, payload => { payload.secret = Buffer.alloc(32, 7).toString("base64url"); }),
    serverRecord: f.serverRecord, now: NOW,
  }));
});

test("malformed QR, empty secret and incompatible versions are rejected", async () => {
  const f = await fixture();
  for (const qr of [
    "", "https://example.invalid/#invite=test",
    "panier-v2-qr.!",
    editQr(f.qr, payload => { payload.v = 2; }),
    editQr(f.qr, payload => { payload.secret = ""; }),
    editQr(f.qr, payload => { payload.extra = true; }),
  ]) await assert.rejects(prepareQrRedemption(qr, NOW));
});

test("QR contains no recipient permissions; physical display does not prove proximity", async () => {
  const f = await fixture();
  const a = await prepareQrRedemption(f.qr, NOW + 1);
  const b = await prepareQrRedemption(f.qr, NOW + 2);
  assert.deepEqual(a, b); // client alone cannot enforce single-use!
  // This test deliberately documents the required server-side consume/revoke rule.
  assert.equal(f.serverRecord.redeemed, undefined);
});

test("owner signing private/public key mismatch is detected before QR display", async () => {
  const owner = await generateSigningIdentity();
  const foreign = await generateSigningIdentity();
  await assert.rejects(prepareQrInvitation({
    listId: LIST, ownerId: owner.actorId, epoch: 1,
    listSecret: secret(), ownerPrivateKey: owner.privateKey,
    ownerPublicJwk: foreign.publicKeyJwk, now: NOW,
  }), /owner key pair mismatch/);
});
