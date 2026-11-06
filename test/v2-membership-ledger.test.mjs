import {test} from "node:test";
import assert from "node:assert/strict";
import {generateSigningIdentity} from "../v2/crypto.mjs";
import {generateRecipientAgreementKey,sealRotatedKeyPackages,
  openRotatedKeyPackage} from "../v2/rekey.mjs";
import {prepareQrInvitation,prepareQrRedemption} from "../v2/qr-pairing.mjs";
import {QrInvitationRegistry,enrollmentStatement} from "../v2/qr-registry.mjs";
import {signGenesis,signRotation,bootstrapLedger,rotateLedger,
  ledgerAuthorizers,readMembershipEvents,verifyMembershipHistory,
  verifiedRekeyRecipients} from "../v2/membership-ledger.mjs";

const LIST="household01",NOW=1_750_000_000_000;
const clone=v=>structuredClone(v);
function doStorage() {
  let values=new Map(),barrier=Promise.resolve();
  return {
    async transaction(fn) {
      const run=async()=>{
        const draft=new Map(Array.from(values,([k,v])=>[k,clone(v)]));
        const tx={get:async key=>draft.get(key),put:async(key,value)=>{draft.set(key,clone(value));}};
        const result=await fn(tx);
        values=draft;
        return result;
      };
      const result=barrier.then(run,run);
      barrier=result.then(()=>{},()=>{});
      return result;
    },
    get:async key=>values.get(key),
  };
}
async function fixture() {
  const owner=await generateSigningIdentity();
  const storage=doStorage();
  const genesis=await signGenesis({listId:LIST,ownerId:owner.actorId,
    ownerPublicJwk:owner.publicKeyJwk,privateKey:owner.privateKey});
  await bootstrapLedger(storage,genesis,owner.publicKeyJwk);
  const authorizers=ledgerAuthorizers(storage);
  const registry=new QrInvitationRegistry({storage,...authorizers,now:()=>NOW+100});
  const listSecret=crypto.getRandomValues(new Uint8Array(32));
  const invitation=await prepareQrInvitation({listId:LIST,ownerId:owner.actorId,
    epoch:1,listSecret,ownerPrivateKey:owner.privateKey,
    ownerPublicJwk:owner.publicKeyJwk,now:NOW});
  const token=(await prepareQrRedemption(invitation.qr,NOW)).token;
  async function request(memberId="newmember01") {
    const recipient=await generateSigningIdentity();
    const agreement=await generateRecipientAgreementKey();
    const nonce=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    const info={listId:LIST,inviteId:invitation.serverRecord.inviteId,
      memberId,nonce,tokenHash:invitation.serverRecord.tokenHash,
      agreementPublicJwk:agreement.publicJwk};
    const proof=Buffer.from(await crypto.subtle.sign(
      {name:"ECDSA",hash:"SHA-256"},recipient.privateKey,
      new TextEncoder().encode(enrollmentStatement(info)))).toString("base64url");
    return {listId:LIST,inviteId:info.inviteId,memberId,nonce,token,
      memberPublicJwk:recipient.publicKeyJwk,agreementPublicJwk:agreement.publicJwk,
      proof};
  }
  return {owner,storage,registry,genesis,invitation,listSecret,request};
}

test("pinned owner genesis verifies and cannot be substituted or replayed",async()=>{
  const f=await fixture();
  const events=await readMembershipEvents(f.storage);
  assert.equal(events.length,1);
  const verified=await verifyMembershipHistory(events,f.owner.publicKeyJwk);
  assert.equal(verified.ownerId,f.owner.actorId);
  assert.equal(verified.epoch,1);
  const attacker=await generateSigningIdentity();
  await assert.rejects(verifyMembershipHistory(events,attacker.publicKeyJwk),/untrusted/);
  await assert.rejects(bootstrapLedger(f.storage,f.genesis,f.owner.publicKeyJwk),/already initialised/);
  const altered=structuredClone(events);altered[0].epoch=2;
  await assert.rejects(verifyMembershipHistory(altered,f.owner.publicKeyJwk));
});

test("QR redemption appends signed-grant / recipient proof to same membership chain",async()=>{
  const f=await fixture();
  await f.registry.createInvitation(f.invitation.serverRecord);
  const recipient=await f.request();
  await f.registry.redeem(recipient);
  const chain=await readMembershipEvents(f.storage);
  assert.equal(chain.length,2);
  const state=await verifyMembershipHistory(chain,f.owner.publicKeyJwk);
  assert.equal(state.sequence,2);
  assert.equal(state.members.length,2);
  assert.equal(state.members[1].memberId,recipient.memberId);
  assert.equal(state.members[1].role,"member");
  assert.equal(state.members[1].publicJwk.x,recipient.memberPublicJwk.x);
  assert.equal(state.members[1].agreementPublicJwk.x,recipient.agreementPublicJwk.x);
  assert.equal(state.usedInvites[0],recipient.inviteId);
  assert.equal((await f.storage.get("membership:state")).head,state.head);
  assert.equal((await f.storage.get("invite:"+recipient.inviteId)).status,"used");
});

test("one concurrent redemption wins and only one history entry is appended",async()=>{
  const f=await fixture();
  await f.registry.createInvitation(f.invitation.serverRecord);
  const candidates=await Promise.all([f.request("newmember01"),f.request("newmember02")]);
  const results=await Promise.allSettled(candidates.map(r=>f.registry.redeem(r)));
  assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
  const chain=await readMembershipEvents(f.storage);
  assert.equal(chain.length,2);
  const state=await verifyMembershipHistory(chain,f.owner.publicKeyJwk);
  assert.equal(state.members.length,2);
});

test("signed epoch rotation invalidates old invitations and cannot be forged",async()=>{
  const f=await fixture();
  await f.registry.createInvitation(f.invitation.serverRecord);
  const recipient=await f.request();
  await f.registry.redeem(recipient);
  const current=await f.storage.get("membership:state");
  const rotation=await signRotation({listId:LIST,sequence:current.sequence+1,
    previous:current.head,ownerId:f.owner.actorId,epoch:current.epoch+1,
    removedMemberId:recipient.memberId,privateKey:f.owner.privateKey});
  const rotated=await rotateLedger(f.storage,rotation);
  assert.equal(rotated.epoch,2);
  assert.equal(rotated.members.find(m=>m.memberId===recipient.memberId).active,false);
  assert.equal((await verifyMembershipHistory(await readMembershipEvents(f.storage),
    f.owner.publicKeyJwk)).head,rotated.head);
  await assert.rejects(rotateLedger(f.storage,rotation),/stale/);
  const wrong=structuredClone(rotation);wrong.epoch=3;wrong.sequence=rotated.sequence+1;
  wrong.previous=rotated.head;
  await assert.rejects(rotateLedger(f.storage,wrong));
  // A DIFFERENT open QR from epoch 1 must fail after signed rotation,
  // even though its own single-use status is still "open".
  const old=await fixture();
  await old.registry.createInvitation(old.invitation.serverRecord);
  const secondInvite=await prepareQrInvitation({
    listId:LIST,ownerId:old.owner.actorId,epoch:1,
    listSecret:old.listSecret,ownerPrivateKey:old.owner.privateKey,
    ownerPublicJwk:old.owner.publicKeyJwk,now:NOW,
  });
  await old.registry.createInvitation(secondInvite.serverRecord);
  const nextToken=(await prepareQrRedemption(secondInvite.qr,NOW)).token;
  const nextRecipient=await generateSigningIdentity();
  const nextAgreement=await generateRecipientAgreementKey();
  const nextNonce=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const nextProof=Buffer.from(await crypto.subtle.sign(
    {name:"ECDSA",hash:"SHA-256"},nextRecipient.privateKey,
    new TextEncoder().encode(enrollmentStatement({
      listId:LIST,inviteId:secondInvite.serverRecord.inviteId,
      memberId:"newmember02",nonce:nextNonce,
      tokenHash:secondInvite.serverRecord.tokenHash,
      agreementPublicJwk:nextAgreement.publicJwk,
    })))).toString("base64url");
  const pending={listId:LIST,inviteId:secondInvite.serverRecord.inviteId,
    token:nextToken,memberId:"newmember02",memberPublicJwk:nextRecipient.publicKeyJwk,
    agreementPublicJwk:nextAgreement.publicJwk,nonce:nextNonce,proof:nextProof};
  await old.registry.redeem(await old.request("newmember01"));
  const previous=await old.storage.get("membership:state");
  const advance=await signRotation({listId:LIST,sequence:previous.sequence+1,
    previous:previous.head,ownerId:old.owner.actorId,epoch:2,
    removedMemberId:"newmember01",privateKey:old.owner.privateKey});
  await rotateLedger(old.storage,advance);
  assert.equal((await old.storage.get("invite:"+pending.inviteId)).status,"open");
  await assert.rejects(old.registry.redeem(pending),/current membership or epoch/);
  assert.equal(await old.storage.get("member:newmember02"),undefined);
});

test("membership ledger detects tampered invite, joined key and missing events",async()=>{
  const f=await fixture();
  await f.registry.createInvitation(f.invitation.serverRecord);
  await f.registry.redeem(await f.request());
  const chain=await readMembershipEvents(f.storage);
  const bad=structuredClone(chain);
  bad[1].memberPublicJwk.x="A".repeat(43);
  await assert.rejects(verifyMembershipHistory(bad,f.owner.publicKeyJwk));
  const badGrant=structuredClone(chain);
  badGrant[1].grant.ciphertext=(badGrant[1].grant.ciphertext[0]==="A"?"B":"A")+
    badGrant[1].grant.ciphertext.slice(1);
  await assert.rejects(verifyMembershipHistory(badGrant,f.owner.publicKeyJwk));
  const skipped=[chain[0],chain[1],chain[1]];
  await assert.rejects(verifyMembershipHistory(skipped,f.owner.publicKeyJwk));
});

test("stale owner authorization fails closed at invitation issuance and consumption",async()=>{
  const f=await fixture();
  await f.registry.createInvitation(f.invitation.serverRecord);
  const r=await f.request();
  const current=await f.storage.get("membership:state");
  // Direct server-side tampering is not a signed transition and would be
  // rejected by verifyMembershipHistory; also gate on current state.
  const changed=structuredClone(current);changed.epoch=2;
  await f.storage.transaction(tx=>tx.put("membership:state",changed));
  await assert.rejects(f.registry.redeem(r),/current membership or epoch/);
  await assert.rejects(f.registry.createInvitation(f.invitation.serverRecord),/authorization/);
});

test("a transaction abort cannot partially commit membership evidence",async()=>{
  const f=await fixture();
  await f.registry.createInvitation(f.invitation.serverRecord);
  const r=await f.request();
  const tx=f.storage.transaction.bind(f.storage);
  let fail=true;
  const broken={transaction:cb=>tx(async inner=>{
    if(fail){
      fail=false;
      const original=inner.put.bind(inner);
      inner.put=async (key,value)=>{
        if(key==="invite:"+r.inviteId&&value.status==="used")
          throw new Error("simulated aborted transaction");
        return original(key,value);
      };
    }
    return cb(inner);
  }),get:f.storage.get};
  const registry=new QrInvitationRegistry({storage:broken,...ledgerAuthorizers(broken),
    now:()=>NOW+100});
  await assert.rejects(registry.redeem(r),/aborted transaction/);
  assert.equal((await readMembershipEvents(f.storage)).length,1);
  assert.equal(await f.storage.get("member:"+r.memberId),undefined);
  await registry.redeem(r);
  assert.equal((await readMembershipEvents(f.storage)).length,2);
});

test("signed member history authenticates ECDH key and rejects substituted key",async()=>{
  const f=await fixture();
  await f.registry.createInvitation(f.invitation.serverRecord);
  const recipient=await f.request();
  await f.registry.redeem(recipient);
  const chain=await readMembershipEvents(f.storage);
  const substituted=await generateRecipientAgreementKey();
  const forged=structuredClone(chain);
  forged[1].agreementPublicJwk=substituted.publicJwk;
  await assert.rejects(verifyMembershipHistory(forged,f.owner.publicKeyJwk),/recipient proof/);
  const verified=await verifyMembershipHistory(chain,f.owner.publicKeyJwk);
  assert.equal(verified.members[1].agreementPublicJwk.x,recipient.agreementPublicJwk.x);
});

test("verified surviving member keys can be used for rekey; revoked identity excluded",async()=>{
  const f=await fixture();
  await f.registry.createInvitation(f.invitation.serverRecord);
  const a=await f.request("newmember01");
  await f.registry.redeem(a);
  const second=await prepareQrInvitation({listId:LIST,ownerId:f.owner.actorId,
    epoch:1,listSecret:f.listSecret,ownerPrivateKey:f.owner.privateKey,
    ownerPublicJwk:f.owner.publicKeyJwk,now:NOW});
  await f.registry.createInvitation(second.serverRecord);
  const agreement=await generateRecipientAgreementKey();
  const signer=await generateSigningIdentity();
  const nonce=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const token=(await prepareQrRedemption(second.qr,NOW)).token;
  const memberId="newmember02";
  const proof=Buffer.from(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},
    signer.privateKey,new TextEncoder().encode(enrollmentStatement({
      listId:LIST,inviteId:second.serverRecord.inviteId,memberId,nonce,
      tokenHash:second.serverRecord.tokenHash,agreementPublicJwk:agreement.publicJwk,
    })))).toString("base64url");
  await f.registry.redeem({listId:LIST,inviteId:second.serverRecord.inviteId,
    memberId,nonce,token,memberPublicJwk:signer.publicKeyJwk,
    agreementPublicJwk:agreement.publicJwk,proof});
  const before=await f.storage.get("membership:state");
  const rotate=await signRotation({listId:LIST,sequence:before.sequence+1,
    previous:before.head,ownerId:f.owner.actorId,epoch:2,
    removedMemberId:a.memberId,privateKey:f.owner.privateKey});
  await rotateLedger(f.storage,rotate);
  const verified=await verifyMembershipHistory(await readMembershipEvents(f.storage),
    f.owner.publicKeyJwk);
  const recipients=verifiedRekeyRecipients(verified,a.memberId);
  assert.deepEqual(recipients,[{
    memberId,agreementPublicJwk:{
      kty:"EC",crv:"P-256",x:agreement.publicJwk.x,y:agreement.publicJwk.y,
    },
  }]);
  const newSecret=crypto.getRandomValues(new Uint8Array(32));
  const envelopes=await sealRotatedKeyPackages({listId:LIST,
    ownerId:f.owner.actorId,epoch:2,rotationHead:verified.head,
    ownerSigningKey:f.owner.privateKey,listSecret:newSecret,
    trustedRecipients:recipients,removedMemberId:a.memberId});
  assert.deepEqual(await openRotatedKeyPackage({
    envelope:envelopes[0],listId:LIST,memberId,
    currentEpoch:2,rotationHead:verified.head,
    trustedOwnerSigningKey:f.owner.publicKey,
    recipientAgreementPrivateKey:agreement.privateKey,
  }),newSecret);
  const outsider=await generateRecipientAgreementKey();
  await assert.rejects(openRotatedKeyPackage({
    envelope:envelopes[0],listId:LIST,memberId,
    currentEpoch:2,rotationHead:verified.head,
    trustedOwnerSigningKey:f.owner.publicKey,
    recipientAgreementPrivateKey:outsider.privateKey,
  }));
});
