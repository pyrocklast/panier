import {test} from "node:test";
import assert from "node:assert/strict";
import {generateSigningIdentity} from "../v2/crypto.mjs";
import {prepareQrInvitation} from "../v2/qr-pairing.mjs";
import {generateRecipientAgreementKey} from "../v2/rekey.mjs";
import {enrollmentStatement} from "../v2/qr-registry.mjs";
import {signGenesis,verifyMembershipHistory} from "../v2/membership-ledger.mjs";
import {verifyTrustedHistory} from "../v2/trust.mjs";

const LIST="household01",NOW=1_750_000_000_000;
async function fixture(){
  const owner=await generateSigningIdentity();
  const genesis=await signGenesis({listId:LIST,ownerId:owner.actorId,
    ownerPublicJwk:owner.publicKeyJwk,privateKey:owner.privateKey});
  const state=await verifyMembershipHistory([genesis],owner.publicKeyJwk);
  const anchor={listId:LIST,ownerId:owner.actorId,
    ownerPublicJwk:owner.publicKeyJwk,source:"owner-local",
    checkpoint:{sequence:state.sequence,head:state.head,epoch:state.epoch}};
  async function join(memberId="newmember01"){
    const signer=await generateSigningIdentity();
    const agreement=await generateRecipientAgreementKey();
    const listSecret=crypto.getRandomValues(new Uint8Array(32));
    const {serverRecord}=await prepareQrInvitation({listId:LIST,
      ownerId:owner.actorId,ownerPublicJwk:owner.publicKeyJwk,
      ownerPrivateKey:owner.privateKey,epoch:1,listSecret,now:NOW});
    const nonce=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    const proof=Buffer.from(await crypto.subtle.sign(
      {name:"ECDSA",hash:"SHA-256"},signer.privateKey,
      new TextEncoder().encode(enrollmentStatement({
        listId:LIST,inviteId:serverRecord.inviteId,memberId,nonce,
        tokenHash:serverRecord.tokenHash,agreementPublicJwk:agreement.publicJwk,
      })))).toString("base64url");
    return {v:2,kind:"join",listId:LIST,sequence:2,
      previous:state.head,ownerId:owner.actorId,epoch:1,
      inviteId:serverRecord.inviteId,memberId,
      memberPublicJwk:{kty:"EC",crv:"P-256",
        x:signer.publicKeyJwk.x,y:signer.publicKeyJwk.y},
      agreementPublicJwk:agreement.publicJwk,nonce,proof,grant:serverRecord};
  }
  return {owner,genesis,anchor,join};
}

test("owner-signed genesis is consistent with a locally pinned owner public key",async()=>{
  const f=await fixture();
  const verified=await verifyTrustedHistory(f.anchor,[f.genesis]);
  assert.equal(verified.head,f.anchor.checkpoint.head);
  assert.equal(verified.ownerId,f.owner.actorId);
});
test("verified, authorized join extends existing checkpoint",async()=>{
  const f=await fixture();
  const member=await f.join();
  const state=await verifyTrustedHistory(f.anchor,[f.genesis,member]);
  assert.equal(state.sequence,2);
  assert.equal(state.members[1].memberId,"newmember01");
  assert.notEqual(state.head,f.anchor.checkpoint.head);
});
test("server cannot rewind to genesis once later membership checkpoint is pinned",async()=>{
  const f=await fixture();
  const member=await f.join();
  const state=await verifyTrustedHistory(f.anchor,[f.genesis,member]);
  const pinned={...f.anchor,checkpoint:{sequence:2,head:state.head,epoch:1}};
  await assert.rejects(verifyTrustedHistory(pinned,[f.genesis]),/rollback/);
});
test("same-sequence signed branch is rejected even if alternate join is valid",async()=>{
  const f=await fixture();
  const original=await f.join("newmember01");
  const competing=await f.join("newmember02");
  const state=await verifyTrustedHistory(f.anchor,[f.genesis,original]);
  const pinned={...f.anchor,checkpoint:{sequence:2,head:state.head,epoch:1}};
  await assert.rejects(verifyTrustedHistory(pinned,[f.genesis,competing]),
    /fork or rollback/);
});
test("server cannot replace owner key/genesis even with valid attacker signature",async()=>{
  const f=await fixture();
  const attacker=await generateSigningIdentity();
  const forged=await signGenesis({listId:LIST,ownerId:attacker.actorId,
    ownerPublicJwk:attacker.publicKeyJwk,privateKey:attacker.privateKey});
  await assert.rejects(verifyTrustedHistory(f.anchor,[forged]),
    /untrusted or malformed/);
});
test("checkpoint cannot be replayed under another list or owner ID",async()=>{
  const f=await fixture();
  await assert.rejects(verifyTrustedHistory({...f.anchor,listId:"household02"},
    [f.genesis]),/different owner or list/);
  await assert.rejects(verifyTrustedHistory({...f.anchor,ownerId:"attacker001"},
    [f.genesis]),/different owner or list/);
});
test("missing or malformed pinned trust root cannot silently TOFU",async()=>{
  const f=await fixture();
  await assert.rejects(verifyTrustedHistory(null,[f.genesis]),/no locally pinned/);
  await assert.rejects(verifyTrustedHistory({...f.anchor,checkpoint:{sequence:3,
    head:f.anchor.checkpoint.head,epoch:1}},[f.genesis]),/rollback/);
});
