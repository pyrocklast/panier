import {test} from "node:test";
import assert from "node:assert/strict";
import {generateSigningIdentity,sealMutation} from "../v2/crypto.mjs";
import {generateRecipientAgreementKey,sealRotatedKeyPackages,
  openRotatedKeyPackage} from "../v2/rekey.mjs";
import {signGenesis,signRotation,previewSignedRotation,
  verifyMembershipHistory,membershipEventHash} from "../v2/membership-ledger.mjs";
import {verifyTrustedHistory} from "../v2/trust.mjs";
import {prepareQrInvitation,prepareQrRedemption} from "../v2/qr-pairing.mjs";
import {enrollmentStatement} from "../v2/qr-registry.mjs";
import {signV2Request,signedRequestPath} from "../v2/api-auth.mjs";

const BASE=process.env.V2_BASE;
if(!BASE)throw Error("V2_BASE required; start isolated Wrangler dev first");
const LIST=()=>crypto.randomUUID();
async function post(path,body,auth,expected=200){
  const res=await fetch(BASE+path,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(auth?{auth,body}:body)});
  const value=await res.json();
  assert.equal(res.status,expected,JSON.stringify({path,value,status:res.status}));
  return value;
}
async function signed({listId,member,route,body,expected=200}) {
  const path=signedRequestPath(listId,route);
  const auth=await signV2Request({listId,memberId:member.id,path,body,
    privateKey:member.keys.privateKey});
  return post(path,body,auth,expected);
}
async function invite({listId,owner,secret,epoch=1}) {
  const prepared=await prepareQrInvitation({listId,ownerId:owner.id,epoch,
    listSecret:secret,ownerPrivateKey:owner.keys.privateKey,
    ownerPublicJwk:owner.keys.publicKeyJwk});
  await signed({listId,member:owner,route:"invitations",body:prepared.serverRecord,expected:201});
  return prepared;
}
async function recipientEnroll({listId,prepared,memberId=crypto.randomUUID()}) {
  const signer=await generateSigningIdentity();
  const agreement=await generateRecipientAgreementKey();
  const token=(await prepareQrRedemption(prepared.qr)).token;
  const nonce=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const statement=enrollmentStatement({listId,
    inviteId:prepared.serverRecord.inviteId,memberId,nonce,
    tokenHash:prepared.serverRecord.tokenHash,
    agreementPublicJwk:agreement.publicJwk});
  const proof=Buffer.from(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},
    signer.privateKey,new TextEncoder().encode(statement))).toString("base64url");
  const body={listId,inviteId:prepared.serverRecord.inviteId,memberId,
    memberPublicJwk:signer.publicKeyJwk,agreementPublicJwk:agreement.publicJwk,
    token,nonce,proof};
  return {member:{id:memberId,keys:signer,agreement},body};
}
async function bootstrap() {
  const listId=LIST();
  const keys=await generateSigningIdentity();
  const owner={id:keys.actorId,keys};
  const event=await signGenesis({listId,ownerId:owner.id,
    ownerPublicJwk:keys.publicKeyJwk,privateKey:keys.privateKey});
  const path=signedRequestPath(listId,"bootstrap");
  const response=await post(path,{event},null,201);
  assert.equal(response.epoch,1);
  return {listId,owner,event};
}

test("isolated v2 Worker health route; production routing not used",async()=>{
  const result=await fetch(BASE+"/health");
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{service:"panier-v2-isolated"});
  assert.equal((await fetch(BASE+"/api/lists")).status,404);
});

test("real SQLite DO: QR enrollment, signed reads, encrypted mutation, rotation and offline retrieval",async()=>{
  const {listId,owner,event:locallySignedGenesis}=await bootstrap();
  const initial=crypto.getRandomValues(new Uint8Array(32));
  const first=await invite({listId,owner,secret:initial});
  const a=await recipientEnroll({listId,prepared:first});
  const second=await invite({listId,owner,secret:initial});
  const b=await recipientEnroll({listId,prepared:second});
  await post(signedRequestPath(listId,"redeem"),{body:a.body},null,201);
  await post(signedRequestPath(listId,"redeem"),{body:b.body},null,201);
  const duplicate=await post(signedRequestPath(listId,"redeem"),{body:a.body},null,409);
  assert.match(duplicate.error,/unavailable|used|consumed/);

  const headData=await signed({listId,member:owner,route:"history",body:{listId}});
  // The owner must have pinned this locally signed genesis BEFORE sending
  // it to bootstrap. Never treat Cloudflare's first history as a trust root.
  const root={listId,ownerId:owner.id,ownerPublicJwk:owner.keys.publicKeyJwk,
    source:"owner-local",checkpoint:{
      sequence:1,head:await membershipEventHash(locallySignedGenesis),epoch:1,
    }};
  const trusted=await verifyTrustedHistory(root,headData.events);
  assert.equal(trusted.members.length,3);
  // An older but valid signed history cannot undo already observed members.
  const currentAnchor={...root,checkpoint:{sequence:trusted.sequence,
    head:trusted.head,epoch:trusted.epoch}};
  await assert.rejects(verifyTrustedHistory(currentAnchor,headData.events.slice(0,1)),
    /rollback/);
  const mutation={listId,id:crypto.randomUUID(),type:"item.add",
    payload:{id:crypto.randomUUID(),name:"Eggs",position:"a"}};
  const sealed=await sealMutation({draft:mutation,epoch:1,actorId:b.member.id,
    privateKey:b.member.keys.privateKey,listSecret:initial});
  const pushed=await signed({listId,member:b.member,route:"mutations",body:sealed});
  assert.equal(pushed.revision,1);
  assert.equal(pushed.duplicate,false);
  const replayed=await signed({listId,member:b.member,route:"mutations",body:sealed});
  assert.equal(replayed.revision,1);
  assert.equal(replayed.duplicate,true);
  const pulled=await signed({listId,member:b.member,route:"pull",body:{listId,since:0}});
  assert.equal(pulled.latest,1);
  assert.equal(pulled.changes[0].ciphertext,sealed.ciphertext);

  const event=await signRotation({listId,sequence:trusted.sequence+1,
    previous:trusted.head,ownerId:owner.id,epoch:2,
    removedMemberId:a.member.id,privateKey:owner.keys.privateKey});
  const future=await previewSignedRotation(trusted,event);
  const fresh=crypto.getRandomValues(new Uint8Array(32));
  const packages=await sealRotatedKeyPackages({listId,ownerId:owner.id,
    epoch:2,rotationHead:future.head,ownerSigningKey:owner.keys.privateKey,
    listSecret:fresh,removedMemberId:a.member.id,
    trustedRecipients:[{memberId:b.member.id,
      agreementPublicJwk:b.member.agreement.publicJwk}]});
  const rotated=await signed({listId,member:owner,route:"rotate",
    body:{event,envelopes:packages}});
  assert.equal(rotated.epoch,2);
  assert.equal(rotated.head,future.head);
  const offline=await signed({listId,member:b.member,route:"key-package",body:{listId}});
  assert.deepEqual(await openRotatedKeyPackage({
    envelope:offline.envelope,listId,memberId:b.member.id,currentEpoch:2,
    rotationHead:future.head,trustedOwnerSigningKey:owner.keys.publicKey,
    recipientAgreementPrivateKey:b.member.agreement.privateKey,
  }),fresh);
  const revoked=await signed({listId,member:a.member,route:"key-package",
    body:{listId},expected:403});
  assert.match(revoked.error,/authorized/);
  const stale=await signed({listId,member:b.member,route:"mutations",
    body:sealed,expected:409});
  assert.match(stale.error,/stale/);

  const newDraft={...mutation,id:crypto.randomUUID(),payload:{...mutation.payload,
    id:crypto.randomUUID(),name:"Milk"}};
  const newSealed=await sealMutation({draft:newDraft,epoch:2,actorId:b.member.id,
    privateKey:b.member.keys.privateKey,listSecret:fresh});
  assert.equal((await signed({listId,member:b.member,route:"mutations",
    body:newSealed})).revision,2);
});

test("signed request rejects tampering, missing credential and nonce replay",async()=>{
  const {listId,owner}=await bootstrap();
  const path=signedRequestPath(listId,"history");
  const body={listId};
  const auth=await signV2Request({listId,memberId:owner.id,path,body,
    privateKey:owner.keys.privateKey});
  assert.equal((await post(path,body,auth)).events.length,1);
  const replay=await post(path,body,auth,409);
  assert.match(replay.error,/replayed/);
  const tampered=await post(path,{listId,extra:true},auth,403);
  assert.match(tampered.error,/mismatch/);
  const unsigned=await post(path,body,null,403);
  assert.match(unsigned.error,/signed/);
  const outsider=await generateSigningIdentity();
  const forged=await signV2Request({listId,memberId:owner.id,path,body,
    privateKey:outsider.privateKey});
  const denied=await post(path,body,forged,403);
  assert.match(denied.error,/signature/);
});

test("atomic key publication rejects incomplete packages in real Durable Object storage",async()=>{
  const {listId,owner}=await bootstrap();
  const initial=crypto.getRandomValues(new Uint8Array(32));
  const inv=await invite({listId,owner,secret:initial});
  const user=await recipientEnroll({listId,prepared:inv});
  await post(signedRequestPath(listId,"redeem"),{body:user.body},null,201);
  const h=await signed({listId,member:owner,route:"history",body:{listId}});
  const current=await verifyMembershipHistory(h.events,owner.keys.publicKeyJwk);
  const event=await signRotation({listId,sequence:current.sequence+1,
    previous:current.head,ownerId:owner.id,epoch:2,
    removedMemberId:user.member.id,privateKey:owner.keys.privateKey});
  const fail=await signed({listId,member:owner,route:"rotate",
    body:{event,envelopes:[{not:"a valid package"}]},expected:409});
  assert.match(fail.error,/incomplete|recipient|invalid/);
  const after=await signed({listId,member:owner,route:"history",body:{listId}});
  assert.equal(after.events.length,h.events.length);
});

test("exact signed owner bootstrap retry is idempotent; substituted owner key cannot replace it",async()=>{
  const {listId,owner,event}=await bootstrap();
  const path=signedRequestPath(listId,"bootstrap");
  const again=await post(path,{event},null,201);
  const originalHash=await membershipEventHash(event);
  assert.equal(again.head,originalHash);
  const attacker=await generateSigningIdentity();
  const counterfeit=await signGenesis({listId,ownerId:attacker.actorId,
    ownerPublicJwk:attacker.publicKeyJwk,privateKey:attacker.privateKey});
  const refused=await post(path,{event:counterfeit},null,409);
  assert.match(refused.error,/already initialised/);
  const history=await signed({listId,member:owner,route:"history",body:{listId}});
  const anchor={listId,ownerId:owner.id,ownerPublicJwk:owner.keys.publicKeyJwk,
    checkpoint:{sequence:1,head:originalHash,epoch:1}};
  const trusted=await verifyTrustedHistory(anchor,history.events);
  assert.equal(trusted.ownerId,owner.id);
});

test("real Durable Object enforces bounded concurrent QR invitations and frees redeemed slots",async()=>{
  const {listId,owner}=await bootstrap();
  const secret=crypto.getRandomValues(new Uint8Array(32));
  const prepared=[];
  for(let i=0;i<5;i++)prepared.push(await invite({listId,owner,secret}));
  const sixth=await prepareQrInvitation({listId,ownerId:owner.id,
    epoch:1,listSecret:secret,ownerPrivateKey:owner.keys.privateKey,
    ownerPublicJwk:owner.keys.publicKeyJwk});
  const denied=await signed({listId,member:owner,route:"invitations",
    body:sixth.serverRecord,expected:429});
  assert.match(denied.error,/invitation quota/);
  const newMember=await recipientEnroll({listId,prepared:prepared[0]});
  await post(signedRequestPath(listId,"redeem"),{body:newMember.body},null,201);
  assert.equal((await signed({listId,member:owner,route:"invitations",
    body:sixth.serverRecord,expected:201})).inviteId,sixth.serverRecord.inviteId);
});

test("real Durable Object enforces member request rate without storing unlimited nonce rows",async()=>{
  const {listId,owner}=await bootstrap();
  const body={listId};
  for(let i=0;i<60;i++){
    const response=await signed({listId,member:owner,route:"history",body});
    assert.equal(response.events.length,1);
  }
  const denied=await signed({listId,member:owner,route:"history",body,expected:429});
  assert.match(denied.error,/rate limit/);
});
