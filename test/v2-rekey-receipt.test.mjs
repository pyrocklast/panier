import {test} from "node:test";
import assert from "node:assert/strict";
import {generateSigningIdentity} from "../v2/crypto.mjs";
import {generateRecipientAgreementKey,sealRotatedKeyPackages} from "../v2/rekey.mjs";
import {receiveAndConfirmRekey,verifyRekeyReceipt} from "../v2/rekey-receipt.mjs";

const LIST="household01", OWNER="ownerAA01", MEMBER="memberAA01", REMOVED="memberBB02";
const HEAD=Buffer.alloc(32,19).toString("base64url");
const SECRET=()=>crypto.getRandomValues(new Uint8Array(32));
async function fixture(){
  const owner=await generateSigningIdentity();
  const member=await generateSigningIdentity();
  const agreement=await generateRecipientAgreementKey();
  const secret=SECRET();
  const verifiedMembership={
    listId:LIST,ownerId:OWNER,epoch:2,head:HEAD,
    members:[
      {memberId:OWNER,role:"owner",active:true,publicJwk:owner.publicKeyJwk},
      {memberId:MEMBER,role:"member",active:true,
        publicJwk:member.publicKeyJwk,agreementPublicJwk:agreement.publicJwk},
      {memberId:REMOVED,role:"member",active:false},
    ],
  };
  const [envelope]=await sealRotatedKeyPackages({
    listId:LIST,ownerId:OWNER,epoch:2,rotationHead:HEAD,
    ownerSigningKey:owner.privateKey,listSecret:secret,
    trustedRecipients:[{memberId:MEMBER,agreementPublicJwk:agreement.publicJwk}],
    removedMemberId:REMOVED,
  });
  const receive=(extra={})=>receiveAndConfirmRekey({
    envelope,verifiedMembership,
    recipientAgreementPrivateKey:agreement.privateKey,
    recipientSigningPrivateKey:member.privateKey,
    trustedOwnerSigningKey:owner.publicKey,
    ...extra,
  });
  const verify=(receipt,extra={})=>verifyRekeyReceipt({
    receipt,envelope,verifiedMembership,ownerListSecret:secret,...extra,
  });
  return {owner,member,agreement,secret,envelope,verifiedMembership,receive,verify};
}

test("authenticated recipient decrypts and owner confirms secret knowledge of exact package",async()=>{
  const f=await fixture();
  const {listSecret,receipt}=await f.receive();
  assert.deepEqual(listSecret,f.secret);
  assert.equal(receipt.listId,LIST);
  assert.equal(receipt.memberId,MEMBER);
  assert.equal(receipt.epoch,2);
  assert.equal(receipt.rotationHead,HEAD);
  assert.equal(receipt.purpose,"panier/v2/rekey/receipt/1");
  assert.equal(receipt.proof.length,43);
  assert.deepEqual(await f.verify(receipt),{
    listId:LIST,epoch:2,rotationHead:HEAD,memberId:MEMBER,
    packageHash:receipt.packageHash,confirmed:true,
  });
  assert.equal(JSON.stringify(receipt).includes(Buffer.from(f.secret).toString("base64url")),false);
});

test("server may forward receipt but cannot fabricate recipient signature",async()=>{
  const f=await fixture();
  const {receipt}=await f.receive();
  const foreign=await generateSigningIdentity();
  const impostor=structuredClone(f.verifiedMembership);
  impostor.members[1].publicJwk=foreign.publicKeyJwk;
  await assert.rejects(f.verify(receipt,{verifiedMembership:impostor}),
    /invalid recipient receipt signature/);
  const changed={...receipt,signature:
    (receipt.signature[0]==="A"?"B":"A")+receipt.signature.slice(1)};
  await assert.rejects(f.verify(changed),/invalid recipient receipt signature|receipt encoding/);
});

test("signed receipt alone does not suffice without the decrypted epoch secret",async()=>{
  const f=await fixture();
  const {receipt}=await f.receive();
  await assert.rejects(f.verify(receipt,{ownerListSecret:SECRET()}),
    /invalid decrypted key confirmation/);
  const changed={...receipt,proof:
    (receipt.proof[0]==="A"?"B":"A")+receipt.proof.slice(1)};
  await assert.rejects(f.verify(changed));
});

test("receipt cannot be replayed for another signed package even in same epoch",async()=>{
  const f=await fixture();
  const {receipt}=await f.receive();
  const [otherPackage]=await sealRotatedKeyPackages({
    listId:LIST,ownerId:OWNER,epoch:2,rotationHead:HEAD,
    ownerSigningKey:f.owner.privateKey,listSecret:f.secret,
    trustedRecipients:[{memberId:MEMBER,agreementPublicJwk:f.agreement.publicJwk}],
    removedMemberId:REMOVED,
  });
  assert.notEqual(otherPackage.ciphertext,f.envelope.ciphertext);
  await assert.rejects(f.verify(receipt,{envelope:otherPackage}),
    /exact key package/);
});

test("receipt cannot be reused for a different epoch or membership head",async()=>{
  const f=await fixture();
  const {receipt}=await f.receive();
  const changedHead=structuredClone(f.verifiedMembership);
  changedHead.head=Buffer.alloc(32,3).toString("base64url");
  await assert.rejects(f.verify(receipt,{verifiedMembership:changedHead}),
    /membership checkpoint/);
  const changedEpoch=structuredClone(f.verifiedMembership);
  changedEpoch.epoch=3;
  await assert.rejects(f.verify(receipt,{verifiedMembership:changedEpoch}),
    /membership checkpoint/);
  const swappedMember=structuredClone(f.verifiedMembership);
  swappedMember.members[1].active=false;
  await assert.rejects(f.verify(receipt,{verifiedMembership:swappedMember}),
    /not an authorized/);
});

test("wrong ECDH private key and owner-signing-key substitution prevent receipt",async()=>{
  const f=await fixture();
  const attacker=await generateRecipientAgreementKey();
  await assert.rejects(f.receive({recipientAgreementPrivateKey:attacker.privateKey}));
  const foreignOwner=await generateSigningIdentity();
  await assert.rejects(f.receive({trustedOwnerSigningKey:foreignOwner.publicKey}),
    /invalid rekey owner signature/);
});

test("wrong recipient signing key cannot attest another device",async()=>{
  const f=await fixture();
  const attacker=await generateSigningIdentity();
  await assert.rejects(f.receive({recipientSigningPrivateKey:attacker.privateKey}),
    /signature does not match registered member/);
});

test("malformed, missing and extra receipt fields are rejected",async()=>{
  const f=await fixture();
  const {receipt}=await f.receive();
  for(const changed of [
    {...receipt,extra:"field"},
    {...receipt,signature:""},
    {...receipt,proof:"?"},
    {...receipt,packageHash:"?"},
    {...receipt,memberId:"othermem01"},
    {...receipt,purpose:"panier/v2/rekey/receipt/0"},
    {...receipt,rotationHead:"?"},
  ])await assert.rejects(f.verify(changed));
});

test("revoked member cannot receive or confirm delivery under active membership",async()=>{
  const f=await fixture();
  const changed=structuredClone(f.verifiedMembership);
  changed.members[1].active=false;
  await assert.rejects(f.receive({verifiedMembership:changed}),
    /not an authorized/);
});

test("receipt creation is deterministic for the same package and key, apart from ECDSA signature",async()=>{
  const f=await fixture();
  const a=await f.receive(),b=await f.receive();
  assert.equal(a.receipt.proof,b.receipt.proof);
  assert.equal(a.receipt.packageHash,b.receipt.packageHash);
  assert.deepEqual(await f.verify(a.receipt),await f.verify(b.receipt));
});
