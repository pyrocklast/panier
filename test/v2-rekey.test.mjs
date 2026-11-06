import {test} from "node:test";
import assert from "node:assert/strict";
import {generateSigningIdentity,sealMutation} from "../v2/crypto.mjs";
import {generateRecipientAgreementKey,sealRotatedKeyPackages,
  openRotatedKeyPackage,classifyPendingEpochs,sealedMutationEpoch} from "../v2/rekey.mjs";

const LIST="household01";
const MEMBER_A="memberAA01",MEMBER_B="memberBB02",REVOKED="removed001";
const HEAD=Buffer.alloc(32,17).toString("base64url");
const SECRET=()=>crypto.getRandomValues(new Uint8Array(32));
async function setup() {
  const owner=await generateSigningIdentity();
  const a=await generateRecipientAgreementKey();
  const b=await generateRecipientAgreementKey();
  const removed=await generateRecipientAgreementKey();
  const listSecret=SECRET();
  const recipients=[
    {memberId:MEMBER_A,agreementPublicJwk:a.publicJwk},
    {memberId:MEMBER_B,agreementPublicJwk:b.publicJwk},
  ];
  const config={listId:LIST,ownerId:owner.actorId,epoch:2,
    rotationHead:HEAD,ownerSigningKey:owner.privateKey,
    listSecret,trustedRecipients:recipients,removedMemberId:REVOKED};
  const packages=await sealRotatedKeyPackages(config);
  const open=(packageIndex,identity,overrides={})=>openRotatedKeyPackage({
    envelope:packages[packageIndex],listId:LIST,
    memberId:recipients[packageIndex].memberId,
    currentEpoch:2,rotationHead:HEAD,
    trustedOwnerSigningKey:owner.publicKey,
    recipientAgreementPrivateKey:identity.privateKey,...overrides,
  });
  return {owner,a,b,removed,listSecret,config,recipients,packages,open};
}

test("owner distributes independent authenticated epoch keys to active members",async()=>{
  const f=await setup();
  assert.equal(f.packages.length,2);
  assert.deepEqual(f.packages.map(p=>p.memberId),[MEMBER_A,MEMBER_B]);
  assert.ok(f.packages.every(p=>p.memberId!==REVOKED));
  assert.deepEqual(await f.open(0,f.a),f.listSecret);
  assert.deepEqual(await f.open(1,f.b),f.listSecret);
  assert.notEqual(f.packages[0].ciphertext,f.packages[1].ciphertext);
  assert.equal(f.a.privateKey.extractable,false);
});

test("revoked device and wrong recipient key cannot decrypt remaining member envelope",async()=>{
  const f=await setup();
  await assert.rejects(f.open(0,f.removed));
  await assert.rejects(f.open(0,f.b));
  await assert.rejects(f.open(1,f.a));
});

test("tampering owner signature, ciphertext, metadata, head or recipient is rejected",async()=>{
  const f=await setup();
  const altered=[
    e=>{e.signature=(e.signature[0]==="A"?"B":"A")+e.signature.slice(1);},
    e=>{e.ciphertext=(e.ciphertext[0]==="A"?"B":"A")+e.ciphertext.slice(1);},
    e=>{e.memberId=MEMBER_B;},
    e=>{e.epoch=3;},
    e=>{e.listId="household02";},
    e=>{e.rotationHead=Buffer.alloc(32,42).toString("base64url");},
    e=>{e.nonce="AAAAAAAAAAAAAAAA";},
    e=>{e.ephemeralPublicJwk.x="A".repeat(43);},
    e=>{e.extra="unexpected";},
  ];
  for(const mutate of altered){
    const envelope=structuredClone(f.packages[0]);
    mutate(envelope);
    await assert.rejects(f.open(0,f.a,{envelope}));
  }
  await assert.rejects(f.open(0,f.a,{rotationHead:Buffer.alloc(32,2).toString("base64url")}));
  await assert.rejects(f.open(0,f.a,{currentEpoch:3}));
});

test("key delivery requires trusted owner key; server substitute fails verification",async()=>{
  const f=await setup();
  const attacker=await generateSigningIdentity();
  await assert.rejects(f.open(0,f.a,{trustedOwnerSigningKey:attacker.publicKey}),
    /invalid rekey owner signature/);
});

test("invalid active-recipient selection blocks accidental distribution to revoked member",async()=>{
  const f=await setup();
  const badRecipient={memberId:REVOKED,agreementPublicJwk:f.removed.publicJwk};
  await assert.rejects(sealRotatedKeyPackages({
    ...f.config,trustedRecipients:[...f.recipients,badRecipient],
  }),/removed or duplicated/);
  await assert.rejects(sealRotatedKeyPackages({
    ...f.config,trustedRecipients:[f.recipients[0],f.recipients[0]],
  }),/removed or duplicated/);
  await assert.rejects(sealRotatedKeyPackages({
    ...f.config,listSecret:new Uint8Array(8),
  }));
});

test("separately prepared packages randomize encryption and remain decryptable",async()=>{
  const f=await setup();
  const again=await sealRotatedKeyPackages(f.config);
  assert.notEqual(f.packages[0].ciphertext,again[0].ciphertext);
  assert.deepEqual(await f.open(0,f.a,{envelope:again[0]}),f.listSecret);
});

test("offline operations sealed in old epoch are quarantined and not mutated",async()=>{
  const owner=await generateSigningIdentity();
  const make=async(id,epoch)=>{
    const draft={listId:LIST,id,type:"item.add",payload:{
      id:"item"+id,name:"Milk",position:"a",
    }};
    const sealed=await sealMutation({draft,epoch,actorId:owner.actorId,
      privateKey:owner.privateKey,listSecret:SECRET()});
    return {id,sealed,localSeq:epoch};
  };
  const stale=await make("mutation01",1);
  const current=await make("mutation02",2);
  const entries=[stale,current];
  const before=structuredClone(entries);
  const result=classifyPendingEpochs(entries,2);
  assert.deepEqual(result.ready,[current]);
  assert.deepEqual(result.quarantined,[{
    id:"mutation01",epoch:1,reason:"stale-epoch-requires-rebase",
  }]);
  assert.equal(sealedMutationEpoch(stale.sealed),1);
  assert.equal(sealedMutationEpoch(current.sealed),2);
  assert.deepEqual(entries,before);
});

test("future-epoch ciphertext and unsealed queued edits are rejected",async()=>{
  const owner=await generateSigningIdentity();
  const draft={listId:LIST,id:"mutation01",type:"item.add",
    payload:{id:"itemAA001",name:"Milk",position:"a"}};
  const sealed=await sealMutation({draft,epoch:3,actorId:owner.actorId,
    privateKey:owner.privateKey,listSecret:SECRET()});
  assert.throws(()=>classifyPendingEpochs([{id:draft.id,sealed}],2),/future epoch/);
  assert.throws(()=>classifyPendingEpochs([{id:draft.id}],2),/missing immutable/);
  assert.throws(()=>classifyPendingEpochs([{id:draft.id,sealed:{
    id:draft.id,ciphertext:"malformed",
  }}],2));
});
