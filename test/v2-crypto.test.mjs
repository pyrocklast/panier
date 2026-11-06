import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateSigningIdentity, importMemberPublicKey, sealMutation,
  openMutation, createSyncSecurity,
} from "../v2/crypto.mjs";

const LIST = "household01", OTHER = "household02";
const secret = () => crypto.getRandomValues(new Uint8Array(32));
const draft = () => ({
  listId: LIST, id: "mutation01", type: "item.add",
  payload: { id: "itemAA001", name: "Milk", position: "a" },
});
const opaque = (sealed, revision = 1) => ({
  id: sealed.id, revision, ciphertext: sealed.ciphertext,
});
const unpack = sealed => JSON.parse(Buffer.from(sealed.ciphertext, "base64url").toString("utf8"));
const repack = envelope => Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
async function setup() {
  const identity = await generateSigningIdentity();
  const listSecret = secret();
  const publicKey = await importMemberPublicKey(identity.publicKeyJwk);
  const seal = (input = draft(), epoch = 1) =>
    sealMutation({ draft: input, epoch, actorId: identity.actorId,
      privateKey: identity.privateKey, listSecret });
  const resolvers = {
    resolveMember: async ({ listId, actorId, epoch }) =>
      listId === LIST && actorId === identity.actorId && epoch === 1 ? publicKey : null,
    resolveListSecret: async ({ listId, epoch }) =>
      listId === LIST && epoch === 1 ? listSecret : null,
  };
  const open = (sealed, extra = {}) =>
    openMutation({ listId: LIST, opaque: opaque(sealed), ...resolvers, ...extra });
  return { identity, listSecret, publicKey, seal, open, resolvers };
}

test("anonymous device private signing key is non-extractable and public key is portable", async () => {
  const { identity } = await setup();
  assert.equal(identity.privateKey.extractable, false);
  assert.equal(identity.privateKey.type, "private");
  assert.equal(identity.publicKeyJwk.kty, "EC");
  assert.equal(identity.publicKeyJwk.crv, "P-256");
  await assert.rejects(crypto.subtle.exportKey("jwk", identity.privateKey));
  assert.notEqual((await generateSigningIdentity()).actorId, identity.actorId);
});

test("round trip signs and decrypts an item mutation with trusted membership", async () => {
  const s = await setup();
  const sealed = await s.seal();
  assert.equal(sealed.listId, LIST);
  assert.equal(sealed.id, "mutation01");
  assert.ok(!sealed.ciphertext.includes("Milk"));
  assert.deepEqual(await s.open(sealed), { ...draft(), revision: 1 });
});

test("authenticated metadata preserves revision from server but never signs server revision", async () => {
  const s = await setup();
  const sealed = await s.seal();
  const result = await openMutation({ listId: LIST,
    opaque: opaque(sealed, 7), ...s.resolvers });
  assert.equal(result.revision, 7);
  assert.equal(result.id, "mutation01");
});

test("ciphertext is randomized; signatures and envelopes reject alterations", async () => {
  const s = await setup();
  const one = await s.seal();
  const two = await s.seal();
  assert.notEqual(one.ciphertext, two.ciphertext);
  for (const mutate of [
    e => { e.data = e.data.slice(0, -1) + (e.data.at(-1) === "A" ? "B" : "A"); },
    e => { e.sig = e.sig.slice(0, -1) + (e.sig.at(-1) === "A" ? "B" : "A"); },
    e => { e.actorId = "attacker001"; },
    e => { e.epoch = 2; },
    e => { e.listId = OTHER; },
    e => { e.id = "mutation02"; },
    e => { e.nonce = "AAAAAAAAAAAAAAAA"; },
  ]) {
    const envelope = unpack(one);
    mutate(envelope);
    const tampered = { ...one, ciphertext: repack(envelope) };
    await assert.rejects(s.open(tampered));
  }
});

test("unknown or revoked member and wrong list are rejected", async () => {
  const s = await setup();
  const sealed = await s.seal();
  await assert.rejects(s.open(sealed, { resolveMember: async () => null }),
    /unauthorized signer/);
  await assert.rejects(openMutation({ listId: OTHER, opaque: opaque(sealed),
    ...s.resolvers }), /wrong list/);
});

test("wrong epoch key is rejected by AES-GCM even with a valid signature", async () => {
  const s = await setup();
  const sealed = await s.seal();
  const wrong = secret();
  await assert.rejects(s.open(sealed, { resolveListSecret: async () => wrong }));
});

test("signature verification refuses a different member public key", async () => {
  const s = await setup();
  const sealed = await s.seal();
  const foreign = await generateSigningIdentity();
  await assert.rejects(s.open(sealed, { resolveMember: async () => foreign.publicKey }),
    /invalid mutation signature/);
});

test("invalid draft fields, missing trusted lookups and malformed keys fail closed", async () => {
  const s = await setup();
  await assert.rejects(s.seal({ ...draft(), payload: { ...draft().payload, name: "" } }));
  await assert.rejects(s.seal({ ...draft(), id: "x" }));
  await assert.rejects(sealMutation({ draft: draft(), epoch: 1,
    actorId: s.identity.actorId, privateKey: s.identity.privateKey,
    listSecret: new Uint8Array(8) }));
  await assert.rejects(importMemberPublicKey({ kty: "RSA", crv: "P-256" }));
  const sealed = await s.seal();
  await assert.rejects(openMutation({ listId: LIST, opaque: opaque(sealed) }),
    /missing trusted key resolvers/);
});

test("noncanonical envelopes, extra fields and oversized messages are rejected", async () => {
  const s = await setup();
  const sealed = await s.seal();
  const envelope = unpack(sealed);
  envelope.extra = true;
  await assert.rejects(s.open({ ...sealed, ciphertext: repack(envelope) }));
  const reversed = Object.fromEntries(Object.entries(unpack(sealed)).reverse());
  await assert.rejects(s.open({ ...sealed, ciphertext: repack(reversed) }));
  await assert.rejects(s.open({ ...sealed, ciphertext: "!" }));
  await assert.rejects(s.open({ ...sealed, ciphertext: "A".repeat(26000) }));
});

test("sync adapter loads durable ciphertext without regenerating encryption", async () => {
  const s = await setup();
  const sealed = await s.seal();
  const seen = [];
  const adapter = createSyncSecurity({
    db: { id: "localdb" },
    loadSealedMutation: async (db, listId, id) => {
      seen.push({ db, listId, id });
      return sealed;
    },
    ...s.resolvers,
  });
  assert.deepEqual(await adapter.decodeAndVerify(LIST, opaque(sealed)), {
    ...draft(), revision: 1,
  });
  assert.strictEqual(await adapter.loadSealed(LIST, "mutation01"), sealed);
  assert.equal(seen[0].db.id, "localdb");
  assert.equal(seen.length, 1);
});

test("cross-list key separation: encryption derived for one list does not work for another", async () => {
  const s = await setup();
  const sealed = await s.seal();
  const obj = unpack(sealed);
  // A list ID substitution is denied by signature and associated data even
  // if the two list secrets happened to have the same raw bytes.
  obj.listId = OTHER;
  await assert.rejects(openMutation({ listId: OTHER,
    opaque: { ...opaque(sealed), ciphertext: repack(obj) },
    resolveMember: async () => s.publicKey,
    resolveListSecret: async () => s.listSecret,
  }));
});
