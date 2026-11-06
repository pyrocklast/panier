import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareQrInvitation, parseInvitationQr, deriveRedemption, openQrInvitation,
  QR_PREFIX,
} from "../v2/qr-invitation.mjs";

const LIST = "household01", OTHER = "household02", OWNER = "memberAA01", NOW = 1700000000000;
const randKey = () => crypto.getRandomValues(new Uint8Array(32));
const b64 = v => Buffer.from(v).toString("base64url");
const unb64 = v => JSON.parse(Buffer.from(v.slice(QR_PREFIX.length), "base64url").toString());
const qrFrom = q => QR_PREFIX + b64(Buffer.from(JSON.stringify(q)));
async function setup() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const listSecret = randKey();
  const create = (values = {}) => prepareQrInvitation({
    listId: LIST, issuerId: OWNER, epoch: 1, listSecret,
    ownerPrivateKey: pair.privateKey, ownerPublicKey: pair.publicKey,
    now: NOW, ...values,
  });
  const invitation = await create();
  const scan = (changes = {}) => openQrInvitation({
    qrText: invitation.qrText, record: invitation.record, now: NOW + 1000,
    claimConfirmed: true, ...changes,
  });
  return { create, invitation, scan, listSecret, pair };
}
test("in-person QR package decrypts only after independently confirmed claim", async () => {
  const s = await setup();
  assert.ok(s.invitation.qrText.startsWith(QR_PREFIX));
  assert.ok(s.invitation.qrText.length <= 600);
  await assert.rejects(openQrInvitation({
    qrText: s.invitation.qrText, record: s.invitation.record, now: NOW + 1000,
  }), /claim not confirmed/);
  const result = await s.scan();
  assert.equal(result.listId, LIST);
  assert.equal(result.epoch, 1);
  assert.equal(result.issuerId, OWNER);
  assert.deepEqual(result.listSecret, s.listSecret);
});

test("server package has no plaintext key or QR decryption/redemption secrets", async () => {
  const s = await setup();
  const qr = parseInvitationQr(s.invitation.qrText);
  const visible = JSON.stringify({ record: s.invitation.record, metadata: s.invitation.serverMetadata });
  assert.ok(!visible.includes(qr.key));
  assert.ok(!visible.includes(qr.redeem));
  assert.ok(!visible.includes(b64(s.listSecret)));
  assert.equal(s.invitation.serverMetadata.invitationId, qr.invitationId);
  assert.equal(s.invitation.serverMetadata.listId, qr.listId);
  assert.ok(s.invitation.serverMetadata.commitment.length >= 40);
  const redemption = await deriveRedemption(s.invitation.qrText);
  assert.equal(redemption.redeemToken, qr.redeem);
});

test("owner prepared ciphertext works after owner disconnects", async () => {
  const s = await setup();
  // The scanner receives only QR text and the stored server record.
  const savedQr = structuredClone(s.invitation.qrText);
  const savedRecord = structuredClone(s.invitation.record);
  const result = await openQrInvitation({
    qrText: savedQr, record: savedRecord,
    now: NOW + 5000, claimConfirmed: true,
  });
  assert.deepEqual(result.listSecret, s.listSecret);
});

test("distinct invitations are unlinkable by transfer secret and use different ciphertext", async () => {
  const s = await setup();
  const second = await s.create();
  const a = parseInvitationQr(s.invitation.qrText);
  const b = parseInvitationQr(second.qrText);
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.redeem, b.redeem);
  assert.notEqual(a.invitationId, b.invitationId);
  assert.notEqual(s.invitation.record.ciphertext, second.record.ciphertext);
});

test("wrong list and swapped owner's public key are rejected", async () => {
  const s = await setup();
  const qr = unb64(s.invitation.qrText);
  await assert.rejects(s.scan({ qrText: qrFrom({ ...qr, listId: OTHER }) }));
  const impostor = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const swapped = { ...s.invitation.record,
    ownerPublicJwk: await crypto.subtle.exportKey("jwk", impostor.publicKey) };
  await assert.rejects(s.scan({ record: swapped }), /fingerprint mismatch/);
});

test("a photographed QR is a bearer secret: no cryptographic proximity proof", async () => {
  const s = await setup();
  const photograph = String(s.invitation.qrText);
  assert.deepEqual((await s.scan({ qrText: photograph })).listSecret, s.listSecret);
  // Single-use is a server obligation, not a property of this local package.
});

test("tampered ciphertext, signature, nonce, epoch and recipient capability fail", async () => {
  const s = await setup();
  const q = unb64(s.invitation.qrText);
  const flip = string => (string[0] === "A" ? "B" : "A") + string.slice(1);
  const badPackages = [
    { ...s.invitation.record, ciphertext: flip(s.invitation.record.ciphertext) },
    { ...s.invitation.record, signature: flip(s.invitation.record.signature) },
    { ...s.invitation.record, nonce: flip(s.invitation.record.nonce) },
    { ...s.invitation.record, header: { ...s.invitation.record.header, epoch: 2 } },
    { ...s.invitation.record, header: { ...s.invitation.record.header, invitationId: "forgedID01" } },
  ];
  for (const record of badPackages) await assert.rejects(s.scan({ record }));
  for (const changed of [
    { key: b64(randKey()) }, { redeem: b64(randKey()) },
    { ownerFingerprint: b64(randKey()) },
  ]) {
    await assert.rejects(s.scan({ qrText: qrFrom({ ...q, ...changed }) }));
  }
});

test("expired package and invalid time windows are refused", async () => {
  const s = await setup();
  await assert.rejects(s.scan({ now: NOW + 10 * 60 * 1000 + 1 }), /expired/);
  await assert.rejects(s.create({ lifetimeMs: 0 }), /expiration/);
  await assert.rejects(s.create({ lifetimeMs: 11 * 60 * 1000 }), /expiration/);
});

test("noncanonical or forged QR encodings fail closed", async () => {
  const s = await setup();
  const q = unb64(s.invitation.qrText);
  const reordered = Object.fromEntries(Object.entries(q).reverse());
  await assert.rejects(s.scan({ qrText: qrFrom(reordered) }), /noncanonical|invalid/);
  await assert.rejects(s.scan({ qrText: "https://example.org/remote-join" }), /invalid QR text/);
  await assert.rejects(s.scan({ qrText: QR_PREFIX + "*" }), /base64url/);
  await assert.rejects(s.scan({ qrText: qrFrom({ ...q, extra: "secret" }) }), /invalid QR payload/);
});

test("secret fingerprint and list-key package do not authenticate real-world identity", async () => {
  const s = await setup();
  const other = await s.create({ listId: OTHER });
  assert.notEqual(parseInvitationQr(other.qrText).listId,
    parseInvitationQr(s.invitation.qrText).listId);
  await assert.rejects(s.scan({ record: other.record }));
});
