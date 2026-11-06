import {test} from "node:test";
import assert from "node:assert/strict";
import {generateRecipientAgreementKey} from "../v2/rekey.mjs";
import {verifyAgreementKeyPair} from "../v2/member-keys.mjs";

test("non-extractable recipient ECDH public/private pair is verified locally",async()=>{
  const agreement=await generateRecipientAgreementKey();
  assert.equal(agreement.privateKey.extractable,false);
  assert.equal(await verifyAgreementKeyPair(agreement),true);
});
test("a substituted agreement public key fails even when both JWKs are valid",async()=>{
  const original=await generateRecipientAgreementKey();
  const substituted=await generateRecipientAgreementKey();
  await assert.rejects(verifyAgreementKeyPair({
    privateKey:original.privateKey,
    publicJwk:substituted.publicJwk,
  }),/mismatch/);
});
test("missing or non-ECDH private key cannot be saved as agreement identity",async()=>{
  const agreement=await generateRecipientAgreementKey();
  await assert.rejects(verifyAgreementKeyPair({
    privateKey:null,publicJwk:agreement.publicJwk,
  }),/invalid private/);
  await assert.rejects(verifyAgreementKeyPair({
    privateKey:agreement.publicKey,publicJwk:agreement.publicJwk,
  }),/invalid private/);
});
