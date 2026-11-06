import {test} from "node:test";
import assert from "node:assert/strict";
import {generateSigningIdentity} from "../v2/crypto.mjs";
import {generateRecipientAgreementKey} from "../v2/rekey.mjs";
import {prepareQrInvitation, prepareQrRedemption} from "../v2/qr-pairing.mjs";
import {QrInvitationRegistry, enrollmentStatement, revocationStatement} from "../v2/qr-registry.mjs";

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
    const agreement = await generateRecipientAgreementKey();
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    const payload = {listId:LIST,inviteId:serverRecord.inviteId,
      token,memberId,nonce};
    const proof = Buffer.from(await crypto.subtle.sign(
      {name:"ECDSA",hash:"SHA-256"},recipient.privateKey,
      new TextEncoder().encode(enrollmentStatement({
        ...payload, tokenHash:serverRecord.tokenHash,
        agreementPublicJwk:agreement.publicJwk,
      })))).toString("base64url");
    return {...payload,memberPublicJwk:recipient.publicKeyJwk,
      agreementPublicJwk:agreement.publicJwk,proof,...override};
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
  assert.equal(f.backend.get("member:"+req.memberId).agreementPublicJwk.x,
    req.agreementPublicJwk.x);
  assert.equal(JSON.stringify(f.backend.get("invite:"+req.inviteId)).includes(f.qr),false);
  // A bare registry without an authenticated membership cache cannot
  // claim a retry succeeded, even when the QR was used by this key.
  await assert.rejects(f.registry.redeem(req),/no longer authorized/);
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
  const substituted=await generateRecipientAgreementKey();
  await assert.rejects(f.registry.redeem({...r,
    agreementPublicJwk:substituted.publicJwk}),/proof/);
  assert.equal(f.backend.get("invite:"+r.inviteId).status,"open");
  await f.registry.redeem(r);
});

test("expired or revoked invitations cannot be redeemed",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const r=await f.request();
  const cancel={listId:LIST,inviteId:r.inviteId,ownerId:f.owner.actorId,epoch:1,
    ownerPublicJwk:f.owner.publicKeyJwk};
  const statement=revocationStatement(cancel);
  const proof=Buffer.from(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},
    f.owner.privateKey,new TextEncoder().encode(statement))).toString("base64url");
  await assert.rejects(f.registry.revokeInvitation(cancel),/signature/);
  assert.deepEqual(await f.registry.revokeInvitation({...cancel,proof}),{status:"revoked"});
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
  await assert.rejects(f.registry.redeem(await f.request("newmember02")),/used|unavailable/);
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

test("public owner signing key alone cannot cancel an invitation",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const req=await f.request();
  const cancel={listId:LIST,inviteId:req.inviteId,ownerId:f.owner.actorId,
    epoch:1,ownerPublicJwk:f.owner.publicKeyJwk};
  const outsider=await generateSigningIdentity();
  const forged=Buffer.from(await crypto.subtle.sign(
    {name:"ECDSA",hash:"SHA-256"},outsider.privateKey,
    new TextEncoder().encode(revocationStatement(cancel)))).toString("base64url");
  await assert.rejects(f.registry.revokeInvitation({...cancel,proof:forged}),/signature/);
  assert.equal(f.backend.get("invite:"+req.inviteId).status,"open");
  await f.registry.redeem(req);
});

test("enrollment without a signed ECDH binding is rejected",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const req=await f.request();
  const {agreementPublicJwk,...missing}=req;
  await assert.rejects(f.registry.redeem(missing),/invalid enrollment request/);
  assert.equal(f.backend.get("invite:"+req.inviteId).status,"open");
});

test("invalid P-256 agreement point cannot be registered even with valid signing proof",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const recipient=await generateSigningIdentity();
  const nonce=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const agreementPublicJwk={kty:"EC",crv:"P-256",
    x:Buffer.alloc(32,0).toString("base64url"),
    y:Buffer.alloc(32,0).toString("base64url")};
  const memberId="newmember01";
  const proof=Buffer.from(await crypto.subtle.sign(
    {name:"ECDSA",hash:"SHA-256"},recipient.privateKey,
    new TextEncoder().encode(enrollmentStatement({
      listId:LIST,inviteId:f.serverRecord.inviteId,memberId,nonce,
      tokenHash:f.serverRecord.tokenHash,agreementPublicJwk,
    })))).toString("base64url");
  await assert.rejects(f.registry.redeem({listId:LIST,
    inviteId:f.serverRecord.inviteId,memberId,nonce,token:f.token,
    memberPublicJwk:recipient.publicKeyJwk,agreementPublicJwk,proof}));
  assert.equal(f.backend.get("invite:"+f.serverRecord.inviteId).status,"open");
});

test("at most five outstanding QR invitations per list; redemption frees one",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const extra=async()=>prepareQrInvitation({listId:LIST,
    ownerId:f.owner.actorId,epoch:1,listSecret:f.listSecret,
    ownerPrivateKey:f.owner.privateKey,
    ownerPublicJwk:f.owner.publicKeyJwk,now:NOW});
  for(let i=0;i<4;i++)
    await f.registry.createInvitation((await extra()).serverRecord);
  const excess=(await extra()).serverRecord;
  await assert.rejects(f.registry.createInvitation(excess),/invitation quota/);
  await f.registry.redeem(await f.request());
  await f.registry.createInvitation(excess);
  const active=f.backend.get("invite:active-index");
  assert.equal(active.length,5);
});

test("same signed device safely recovers enrollment after lost response",async()=>{
  const f=await setup();
  await f.registry.createInvitation(f.serverRecord);
  const req=await f.request();
  const first=await f.registry.redeem(req);
  assert.equal(first.alreadyUsed,false);
  await f.backend.transaction(tx=>tx.put("membership:state",{
    listId:LIST,epoch:1,members:[{memberId:req.memberId,active:true,
      publicJwk:req.memberPublicJwk,
      agreementPublicJwk:req.agreementPublicJwk}],
  }));
  const snapshot=f.backend.get("invite:"+req.inviteId);
  const retry=await f.registry.redeem(req);
  assert.equal(retry.alreadyUsed,true);
  assert.equal(retry.currentEpoch,1);
  assert.equal(retry.memberId,req.memberId);
  assert.deepEqual(f.backend.get("invite:"+req.inviteId),snapshot);
  const swapped=await f.request(req.memberId);
  await assert.rejects(f.registry.redeem(swapped),/no longer authorized/);
  await assert.rejects(f.registry.redeem(await f.request("anotherAA01")),
    /used by another device/);
});
