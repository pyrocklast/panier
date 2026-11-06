import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnrollmentProof, verifyEnrollmentProof } from "../v2/qr-enrollment-proof.mjs";

const LIST = "household01", INVITE = "invitation01", ACTOR = "memberBB02";
const randomChallenge = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
async function recipient() {
  const pair = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);
  return {privateKey:pair.privateKey,publicKey:pair.publicKey,actorId:ACTOR};
}
async function fixture() {
  const identity=await recipient(),challenge=randomChallenge();
  const proof=await createEnrollmentProof({listId:LIST,invitationId:INVITE,challenge,...identity});
  const check=(p=proof,changed={})=>verifyEnrollmentProof({
    proof:p,expectedListId:LIST,expectedInvitationId:INVITE,
    expectedChallenge:challenge,...changed,
  });
  return {proof,check,identity,challenge};
}
test("new installation proves control of non-extractable signing key",async()=>{
  const f=await fixture();
  assert.equal(f.identity.privateKey.extractable,false);
  assert.equal(await f.check(),true);
  assert.equal(f.proof.publicKey.kty,"EC");
  assert.ok(!JSON.stringify(f.proof).includes("privateKey"));
});
test("challenge, list, invitation and actor substitutions are rejected",async()=>{
  const f=await fixture();
  await assert.rejects(f.check({...f.proof,invitationId:"anotherINV01"}));
  await assert.rejects(f.check({...f.proof,listId:"anotherList01"}));
  assert.equal(await f.check({...f.proof,actorId:"anotherActor01"}),false);
  await assert.rejects(f.check(f.proof,{expectedChallenge:randomChallenge()}));
});
test("foreign public key and modified signature cannot authenticate",async()=>{
  const f=await fixture();
  const other=await recipient();
  const pub=await crypto.subtle.exportKey("jwk",other.publicKey);
  const fake={kty:"EC",crv:"P-256",x:pub.x,y:pub.y};
  assert.equal(await f.check({...f.proof,publicKey:fake}),false);
  const sig=f.proof.signature;
  const replacement=(sig[0]==="A"?"B":"A")+sig.slice(1);
  assert.equal(await f.check({...f.proof,signature:replacement}),false);
});
test("proof refuses unexpected keys and invalid/short challenges",async()=>{
  const f=await fixture();
  await assert.rejects(f.check({...f.proof,extra:1}));
  await assert.rejects(createEnrollmentProof({
    listId:LIST,invitationId:INVITE,challenge:"AAAA",...f.identity,
  }),/challenge/);
});
test("a replayed proof still verifies cryptographically; server must consume challenge",async()=>{
  const f=await fixture();
  assert.equal(await f.check(),true);
  assert.equal(await f.check(),true);
  // This is a protocol limitation, NOT a working single-use server check.
});
