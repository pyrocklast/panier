import {test} from "node:test";
import assert from "node:assert/strict";
import {generateSigningIdentity} from "../v2/crypto.mjs";
import {signGenesis} from "../v2/membership-ledger.mjs";
import {verifiedHistoricalMemberKey} from "../v2/trusted-sync.mjs";

test("historical author keys are derived from signed membership events only",async()=>{
  const owner=await generateSigningIdentity();
  const member=await generateSigningIdentity();
  const root=await signGenesis({listId:"household01",ownerId:owner.actorId,
    ownerPublicJwk:owner.publicKeyJwk,privateKey:owner.privateKey});
  const memberId="memberAA01";
  const events=[root,{
    kind:"join",memberId,epoch:1,memberPublicJwk:member.publicKeyJwk,
  },{kind:"rotate",removedMemberId:memberId,epoch:2}];
  assert.equal(verifiedHistoricalMemberKey(events,memberId,1)?.x,
    member.publicKeyJwk.x);
  assert.equal(verifiedHistoricalMemberKey(events,memberId,2),null);
  assert.equal(verifiedHistoricalMemberKey(events,memberId,3),null);
  assert.equal(verifiedHistoricalMemberKey(events,"unknown001",1),null);
  assert.equal(verifiedHistoricalMemberKey(events,owner.actorId,2)?.x,
    owner.publicKeyJwk.x);
});
test("invalid member lookup never defaults to trusting the requested identity",()=>{
  assert.throws(()=>verifiedHistoricalMemberKey([], "memberAA01",1));
  assert.throws(()=>verifiedHistoricalMemberKey([{}],"memberAA01",0));
  assert.throws(()=>verifiedHistoricalMemberKey([{}],null,1));
});
