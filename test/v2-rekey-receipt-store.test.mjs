import {test} from "node:test";
import assert from "node:assert/strict";
import {generateSigningIdentity} from "../v2/crypto.mjs";
import {generateRecipientAgreementKey,sealRotatedKeyPackages} from "../v2/rekey.mjs";
import {receiveAndConfirmRekey,verifyRekeyReceipt} from "../v2/rekey-receipt.mjs";
import {storeSignedRekeyReceipt,getStoredRekeyReceipts} from "../v2/rekey-receipt-store.mjs";

const LIST="household01",OWNER="ownerAA01",MEMBER="memberAA01",REMOVED="removed001";
const HEAD=Buffer.alloc(32,28).toString("base64url");
function mock(initial){
  let values=new Map(Object.entries(initial)),queue=Promise.resolve();
  return {
    transaction(fn){
      const work=async()=>{
        const next=new Map([...values].map(([k,v])=>[k,structuredClone(v)]));
        const tx={get:async k=>next.get(k),put:async(k,v)=>next.set(k,structuredClone(v))};
        const result=await fn(tx);values=next;return result;
      };
      const result=queue.then(work,work);
      queue=result.then(()=>{},()=>{});
      return result;
    },
    snapshot:()=>structuredClone([...values]),
  };
}
async function fixture(){
  const owner=await generateSigningIdentity();
  const signer=await generateSigningIdentity();
  const agreement=await generateRecipientAgreementKey();
  const secret=crypto.getRandomValues(new Uint8Array(32));
  const members=[{memberId:OWNER,role:"owner",active:true,
    publicJwk:owner.publicKeyJwk},
    {memberId:MEMBER,role:"member",active:true,
      publicJwk:signer.publicKeyJwk,agreementPublicJwk:agreement.publicJwk}];
  const membership={listId:LIST,ownerId:OWNER,epoch:2,head:HEAD,members};
  const [envelope]=await sealRotatedKeyPackages({
    listId:LIST,ownerId:OWNER,epoch:2,rotationHead:HEAD,
    ownerSigningKey:owner.privateKey,listSecret:secret,
    removedMemberId:REMOVED,
    trustedRecipients:[{memberId:MEMBER,agreementPublicJwk:agreement.publicJwk}],
  });
  const storage=mock({
    "membership:state":membership,
    "rekey:epoch-fence":{listId:LIST,epoch:2,head:HEAD,sequence:3},
    ["rekey:manifest:"+HEAD]:{listId:LIST,epoch:2,head:HEAD,
      memberIds:[MEMBER],sequence:3,status:"published"},
    ["rekey:package:2:"+MEMBER]:envelope,
  });
  const {receipt}=await receiveAndConfirmRekey({
    envelope,verifiedMembership:membership,
    recipientAgreementPrivateKey:agreement.privateKey,
    recipientSigningPrivateKey:signer.privateKey,
    trustedOwnerSigningKey:owner.publicKey,
  });
  return {owner,signer,agreement,secret,membership,envelope,storage,receipt};
}
test("member receipt is durably stored and owner independently verifies HMAC",async()=>{
  const f=await fixture();
  const result=await storeSignedRekeyReceipt(f.storage,{
    listId:LIST,memberId:MEMBER,receipt:f.receipt});
  assert.equal(result.stored,true);
  assert.equal(result.verifiedByOwner,false);
  assert.equal(result.duplicate,false);
  const records=await getStoredRekeyReceipts(f.storage,{listId:LIST});
  assert.deepEqual(records.receipts,[f.receipt]);
  assert.equal(records.verifiedByOwner,false);
  assert.equal((await verifyRekeyReceipt({
    receipt:records.receipts[0],envelope:f.envelope,
    verifiedMembership:f.membership,ownerListSecret:f.secret,
  })).confirmed,true);
});

test("idempotent exact receipt replay and concurrent duplicate commit do not overwrite",async()=>{
  const f=await fixture();
  const results=await Promise.all([
    storeSignedRekeyReceipt(f.storage,{listId:LIST,memberId:MEMBER,receipt:f.receipt}),
    storeSignedRekeyReceipt(f.storage,{listId:LIST,memberId:MEMBER,receipt:f.receipt}),
  ]);
  assert.deepEqual(results.map(r=>r.duplicate).sort(),[false,true]);
  assert.equal((await getStoredRekeyReceipts(f.storage,{listId:LIST}))
    .receipts.length,1);
});

test("tampered receipt signature, wrong head or changed package hash fail atomically",async()=>{
  const f=await fixture();
  const initial=f.storage.snapshot();
  for(const change of [
    r=>{r.signature=(r.signature[0]==="A"?"B":"A")+r.signature.slice(1);},
    r=>{r.rotationHead=Buffer.alloc(32,5).toString("base64url");},
    r=>{r.packageHash=Buffer.alloc(32,6).toString("base64url");},
    r=>{r.memberId="outsider01";},
    r=>{r.extra="not allowed";},
  ]){
    const bad=structuredClone(f.receipt);
    change(bad);
    await assert.rejects(storeSignedRekeyReceipt(f.storage,{
      listId:LIST,memberId:MEMBER,receipt:bad}));
  }
  assert.deepEqual(f.storage.snapshot(),initial);
});

test("server stores a properly signed but wrong-key proof as UNVERIFIED, owner rejects",async()=>{
  const f=await fixture();
  const wrong=crypto.getRandomValues(new Uint8Array(32));
  // Server has no new epoch key and must not pretend it can check HMAC.
  const bad={...f.receipt,proof:Buffer.alloc(32,2).toString("base64url")};
  const signed={v:bad.v,purpose:bad.purpose,listId:bad.listId,
    epoch:bad.epoch,rotationHead:bad.rotationHead,ownerId:bad.ownerId,
    memberId:bad.memberId,packageHash:bad.packageHash,proof:bad.proof};
  bad.signature=Buffer.from(await crypto.subtle.sign({
    name:"ECDSA",hash:"SHA-256"},f.signer.privateKey,
    new TextEncoder().encode(JSON.stringify(signed)))).toString("base64url");
  const result=await storeSignedRekeyReceipt(f.storage,{
    listId:LIST,memberId:MEMBER,receipt:bad});
  assert.equal(result.verifiedByOwner,false);
  await assert.rejects(verifyRekeyReceipt({receipt:bad,envelope:f.envelope,
    verifiedMembership:f.membership,ownerListSecret:f.secret}),
  /invalid decrypted key confirmation/);
  assert.ok(wrong.length===32);
});

test("unknown or revoked member cannot write a delivery receipt",async()=>{
  const f=await fixture();
  const previous=f.storage.snapshot();
  const broken=mock({
    ...Object.fromEntries(previous),
    "membership:state":{...f.membership,
      members:f.membership.members.map(m=>m.memberId===MEMBER?{...m,active:false}:m)},
  });
  await assert.rejects(storeSignedRekeyReceipt(broken,{
    listId:LIST,memberId:MEMBER,receipt:f.receipt}),
  /cannot acknowledge/);
});
