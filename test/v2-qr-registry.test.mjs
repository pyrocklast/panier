import {test} from "node:test";
import assert from "node:assert/strict";
import {generateSigningIdentity} from "../v2/crypto.mjs";
import {prepareQrInvitation, prepareQrRedemption} from "../v2/qr-pairing.mjs";
import {QrInvitationRegistry, enrollmentStatement} from "../v2/qr-registry.mjs";

const NOW = 1_750_000_000_000;
const LIST = "household01";
const clone = x => structuredClone(x);

// Mock of Durable Object storage.transaction: serialises, and atomically
// rolls back the entire in-memory snapshot on any rejected transaction.
function storage() {
  let values = new Map(), previous = Promise.resolve();
  return {
    async transaction(fn) {
      const run = async () => {
        const next = new Map(Array.from(values, ([k,v]) => [k,clone(v)]));
        const tx = {get: async k => next.get(k), put: async (k,v) => {
          next.set(k,clone(v));
        }};
        const result = await fn(tx);
        values = next;
        return result;
      };
      const outcome = previous.then(run,run);
      previous = outcome.then(()=>{},()=>{});
      return outcome;
    },
    get: k => values.get(k),
  };
}
async function setup() {
  const owner = await generateSigningIdentity();
  const listSecret = crypto.getRandomValues(new Uint8Array(32));
  const {qr,serverRecord} = await prepareQrInvitation({
    listId:LIST, ownerId:owner.actorId, epoch:1, listSecret,
    ownerPrivateKey:owner.privateKey, ownerPublicJwk:owner.publicKeyJwk,
    now:NOW,
  });
  const token = (await prepareQrRedemption(qr, NOW)).token;
  const backend = storage();
  const registry = new QrInvitationRegistry({
    storage:backend, now:()=>NOW+100,
    authOwner: async ({listId,ownerId,epoch,ownerPublicJwk}) =>
      listId===LIST && ownerId===owner.actorId && epoch===1 &&
      ownerPublicJwk.x===owner.publicKeyJwk.x &&
      ownerPublicJwk.y===owner.publicKeyJwk.y,
    authorizeEnrollment: async ({listId,ownerId,epoch}) =>
      listId===LIST && ownerId===owner.actorId && epoch===1,
  });
  async function request(memberId="newmember01", override={}) {
    const recipient = await generateSigningIdentity();
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    const payload = {listId:LIST,inviteId:serverRecord.inviteId,
      token,memberId,nonce};
    const proof = Buffer.from(await crypto.subtle.sign(
      {name:"ECDSA",hash:"SHA-256"},recipient.privateKey,
      new TextEncoder().encode(enrollmentStatement({
        ...payload, tokenHash:serverRecord.tokenHash,
      })))).toString("base64url");
    return {...payload,memberPublicJwk:recipient.publicKeyJwk,proof,...override};
  }
  return {owner,listSecret,qr,serverRecord,token,backend,registry,request};
}

test("valid owner creates and recipient binds public signing key on one-use redemption",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const req=await f.request();
  const out=await f.registry.redeem(req);
  assert.equal(out.memberId,req.memberId);
  assert.deepEqual(out.serverRecord,f.serverRecord);
  assert.equal(f.backend.get("invite:"+req.inviteId).status,"used");
  assert.equal(f.backend.get("member:"+req.memberId).publicJwk.x,req.memberPublicJwk.x);
  assert.equal(JSON.stringify(f.backend.get("invite:"+req.inviteId)).includes(f.qr),false);
  await assert.rejects(f.registry.redeem(req),/unavailable/);
});

test("two simultaneous correct redemptions grant exactly one membership",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const a=await f.request("newmember01"),b=await f.request("newmember02");
  const settled=await Promise.allSettled([f.registry.redeem(a),f.registry.redeem(b)]);
  assert.equal(settled.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(settled.filter(x=>x.status==="rejected").length,1);
  assert.equal(Number(!!f.backend.get("member:newmember01"))+
    Number(!!f.backend.get("member:newmember02")),1);
});

test("stolen token / altered signature / substitute device identity cannot register",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const r=await f.request();
  await assert.rejects(f.registry.redeem({...r,token:Buffer.alloc(32,2).toString("base64url")}),/proof/);
  await assert.rejects(f.registry.redeem({...r,memberId:"newmember02"}),/proof/);
  const foreign=await generateSigningIdentity();
  await assert.rejects(f.registry.redeem({...r,memberPublicJwk:foreign.publicKeyJwk}),/proof/);
  assert.equal(f.backend.get("invite:"+r.inviteId).status,"open");
  await f.registry.redeem(r);
});

test("expired or revoked invitations cannot be redeemed",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const r=await f.request();
  assert.deepEqual(await f.registry.revokeInvitation({
    listId:LIST,inviteId:r.inviteId,ownerId:f.owner.actorId,epoch:1,
    ownerPublicJwk:f.owner.publicKeyJwk,
  }),{status:"revoked"});
  await assert.rejects(f.registry.redeem(r),/unavailable/);
  const late=await setup();
  await late.registry.createInvitation(late.serverRecord);
  late.registry.now=()=>NOW+600_001;
  await assert.rejects(late.registry.redeem(await late.request()),/unavailable/);
});

test("forged owner package, mismatched owner key and duplicate invitation IDs fail closed",async()=>{
  const f=await setup();
  const bad=structuredClone(f.serverRecord);
  bad.ciphertext=(bad.ciphertext[0]==="A"?"B":"A")+bad.ciphertext.slice(1);
  await assert.rejects(f.registry.createInvitation(bad),/signature/);
  await f.registry.createInvitation(f.serverRecord);
  await assert.rejects(f.registry.createInvitation(f.serverRecord),/already registered/);
  const denied=new QrInvitationRegistry({storage:storage(),now:()=>NOW,
    authOwner:async()=>false});
  await assert.rejects(denied.createInvitation(f.serverRecord),/authorization/);
  const noAuth=new QrInvitationRegistry({storage:storage(),now:()=>NOW});
  await assert.rejects(noAuth.createInvitation(f.serverRecord),/authorization/);
});

test("used or revoked QR does not create a second member even with same token",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  await f.registry.redeem(await f.request("newmember01"));
  await assert.rejects(f.registry.redeem(await f.request("newmember02")),/unavailable/);
  assert.equal(f.backend.get("member:newmember02"),undefined);
});

test("transaction rollback prevents partial membership on failure",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const original=f.backend.transaction.bind(f.backend);
  let inject=true;
  const failingStorage={
    transaction:fn=>original(async tx=>{
      if (!inject) return fn(tx);
      inject=false;
      const originalPut=tx.put.bind(tx);
      tx.put=async(key,value)=>{
        if(key.startsWith("invite:") && value.status==="used") throw Error("simulated disk abort");
        return originalPut(key,value);
      };
      return fn(tx);
    }),
  };
  const registry=new QrInvitationRegistry({
    storage:failingStorage,now:()=>NOW+100,
    authOwner:async()=>true,
    authorizeEnrollment:async()=>true,
  });
  const req=await f.request();
  await assert.rejects(registry.redeem(req),/disk abort/);
  assert.equal(f.backend.get("member:"+req.memberId),undefined);
  assert.equal(f.backend.get("invite:"+req.inviteId).status,"open");
  await registry.redeem(req);
  assert.equal(f.backend.get("invite:"+req.inviteId).status,"used");
});

test("revocation/epoch gate checked at consume time, including after valid issuance", async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const request=await f.request();
  f.registry.authorizeEnrollment=async()=>false; // member revoked or epoch advanced
  await assert.rejects(f.registry.redeem(request),/current membership or epoch/);
  assert.equal(f.backend.get("invite:"+request.inviteId).status,"open");
  assert.equal(f.backend.get("member:"+request.memberId),undefined);
  f.registry.authorizeEnrollment=undefined;
  await assert.rejects(f.registry.redeem(request),/current membership or epoch/);
});
