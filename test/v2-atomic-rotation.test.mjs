import {test} from "node:test";
import assert from "node:assert/strict";
import {generateSigningIdentity} from "../v2/crypto.mjs";
import {generateRecipientAgreementKey,sealRotatedKeyPackages,
  openRotatedKeyPackage} from "../v2/rekey.mjs";
import {prepareQrInvitation,prepareQrRedemption} from "../v2/qr-pairing.mjs";
import {QrInvitationRegistry,enrollmentStatement} from "../v2/qr-registry.mjs";
import {signGenesis,signRotation,bootstrapLedger,ledgerAuthorizers,
  previewSignedRotation,readMembershipEvents,verifyMembershipHistory}
  from "../v2/membership-ledger.mjs";
import {publishAtomicRotation,readCurrentKeyPackage,assertCurrentEpochAppend}
  from "../v2/atomic-rotation.mjs";

const LIST="household01",NOW=1_750_000_000_000;
const REMOVED="removed001",ACTIVE="memberAA01",OTHER="memberBB02";
const clone=x=>structuredClone(x);
function store() {
  let values=new Map(),prior=Promise.resolve();
  return {
    async transaction(callback) {
      const run=async()=>{
        const staged=new Map([...values].map(([k,v])=>[k,clone(v)]));
        const tx={
          get:async k=>staged.get(k),
          put:async(k,v)=>{staged.set(k,clone(v));},
        };
        const result=await callback(tx);
        values=staged;
        return result;
      };
      const outcome=prior.then(run,run);
      prior=outcome.then(()=>{},()=>{});
      return outcome;
    },
    get:async k=>values.get(k),
    snapshot:()=>clone([...values]),
  };
}
async function setup(activeIds=[REMOVED,ACTIVE]) {
  const storage=store();
  const owner=await generateSigningIdentity();
  const genesis=await signGenesis({listId:LIST,ownerId:owner.actorId,
    ownerPublicJwk:owner.publicKeyJwk,privateKey:owner.privateKey});
  await bootstrapLedger(storage,genesis,owner.publicKeyJwk);
  const registry=new QrInvitationRegistry({
    storage,...ledgerAuthorizers(storage),now:()=>NOW+100,
  });
  const registrations=new Map();
  for(const memberId of activeIds) {
    const signed=await generateSigningIdentity();
    const agreement=await generateRecipientAgreementKey();
    const listSecret=crypto.getRandomValues(new Uint8Array(32));
    const {qr,serverRecord}=await prepareQrInvitation({listId:LIST,
      ownerId:owner.actorId,epoch:1,listSecret,
      ownerPrivateKey:owner.privateKey,ownerPublicJwk:owner.publicKeyJwk,now:NOW});
    await registry.createInvitation(serverRecord);
    const token=(await prepareQrRedemption(qr,NOW)).token;
    const nonce=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    const statement=enrollmentStatement({listId:LIST,inviteId:serverRecord.inviteId,
      memberId,nonce,tokenHash:serverRecord.tokenHash,
      agreementPublicJwk:agreement.publicJwk});
    const proof=Buffer.from(await crypto.subtle.sign({
      name:"ECDSA",hash:"SHA-256"},signed.privateKey,
      new TextEncoder().encode(statement))).toString("base64url");
    await registry.redeem({listId:LIST,inviteId:serverRecord.inviteId,
      memberId,nonce,token,memberPublicJwk:signed.publicKeyJwk,
      agreementPublicJwk:agreement.publicJwk,proof});
    registrations.set(memberId,{signed,agreement});
  }
  async function prepare(removedMemberId=REMOVED) {
    const current=await storage.get("membership:state");
    const event=await signRotation({listId:LIST,sequence:current.sequence+1,
      previous:current.head,ownerId:owner.actorId,
      epoch:current.epoch+1,removedMemberId,privateKey:owner.privateKey});
    const preview=await previewSignedRotation(current,event);
    const receivers=preview.members.filter(m=>m.active&&m.role==="member")
      .map(m=>({memberId:m.memberId,agreementPublicJwk:m.agreementPublicJwk}));
    const secret=crypto.getRandomValues(new Uint8Array(32));
    const envelopes=receivers.length?await sealRotatedKeyPackages({
      listId:LIST,ownerId:owner.actorId,epoch:preview.epoch,
      rotationHead:preview.head,ownerSigningKey:owner.privateKey,
      listSecret:secret,trustedRecipients:receivers,removedMemberId,
    }):[];
    return {event,preview,envelopes,secret};
  }
  return {storage,owner,registrations,registry,prepare};
}

test("publishes signed epoch, every recipient envelope and write fence atomically",async()=>{
  const f=await setup();
  const prepared=await f.prepare();
  const result=await publishAtomicRotation(f.storage,prepared);
  assert.equal(result.epoch,2);
  assert.equal(result.head,prepared.preview.head);
  assert.deepEqual(result.recipients,[ACTIVE]);
  const state=await f.storage.get("membership:state");
  assert.equal(state.epoch,2);
  assert.equal(state.head,prepared.preview.head);
  assert.equal(state.members.find(m=>m.memberId===REMOVED).active,false);
  assert.equal((await f.storage.get("rekey:epoch-fence")).epoch,2);
  const verified=await verifyMembershipHistory(await readMembershipEvents(f.storage),
    f.owner.publicKeyJwk);
  assert.equal(verified.head,result.head);
  assert.equal(verified.epoch,2);
  const {envelope,manifest}=await readCurrentKeyPackage(f.storage,{
    listId:LIST,memberId:ACTIVE});
  assert.deepEqual(envelope,prepared.envelopes[0]);
  assert.deepEqual(manifest.memberIds,[ACTIVE]);
  const key=await openRotatedKeyPackage({envelope,listId:LIST,memberId:ACTIVE,
    currentEpoch:2,rotationHead:result.head,
    trustedOwnerSigningKey:f.owner.publicKey,
    recipientAgreementPrivateKey:f.registrations.get(ACTIVE).agreement.privateKey});
  assert.deepEqual(key,prepared.secret);
});

test("an offline surviving member can fetch later, revoked member cannot fetch",async()=>{
  const f=await setup();
  await publishAtomicRotation(f.storage,await f.prepare());
  assert.equal((await readCurrentKeyPackage(f.storage,{listId:LIST,memberId:ACTIVE}))
    .manifest.status,"published");
  await assert.rejects(readCurrentKeyPackage(f.storage,{
    listId:LIST,memberId:REMOVED}),/not an active/);
});

test("missing recipient or duplicate recipient fails before any membership change",async()=>{
  const f=await setup([REMOVED,ACTIVE,OTHER]);
  const prepared=await f.prepare();
  assert.equal(prepared.envelopes.length,2);
  const before=f.storage.snapshot();
  await assert.rejects(publishAtomicRotation(f.storage,{
    ...prepared,envelopes:prepared.envelopes.slice(0,1),
  }),/incomplete/);
  await assert.rejects(publishAtomicRotation(f.storage,{
    ...prepared,envelopes:[prepared.envelopes[0],prepared.envelopes[0]],
  }),/duplicate/);
  assert.deepEqual(f.storage.snapshot(),before);
});

test("owner signatures, epoch, member key, ciphertext and rotation head are validated",async()=>{
  const f=await setup();
  const prepared=await f.prepare();
  const before=f.storage.snapshot();
  const foreign=await generateSigningIdentity();
  const bad=structuredClone(prepared.envelopes[0]);
  bad.ciphertext=(bad.ciphertext[0]==="A"?"B":"A")+bad.ciphertext.slice(1);
  await assert.rejects(publishAtomicRotation(f.storage,{
    ...prepared,envelopes:[bad]}),/signature/);
  const substitute=structuredClone(prepared.envelopes[0]);
  const unrelated=await generateRecipientAgreementKey();
  substitute.recipientAgreementPublicJwk=unrelated.publicJwk;
  await assert.rejects(publishAtomicRotation(f.storage,{
    ...prepared,envelopes:[substitute]}),/recipient\/key/);
  const wrongEvent=structuredClone(prepared.event);
  wrongEvent.ownerId=foreign.actorId;
  await assert.rejects(publishAtomicRotation(f.storage,{
    ...prepared,event:wrongEvent}),/rotation/);
  const wrongHead=structuredClone(prepared.envelopes[0]);
  wrongHead.rotationHead=Buffer.alloc(32,2).toString("base64url");
  await assert.rejects(publishAtomicRotation(f.storage,{
    ...prepared,envelopes:[wrongHead]}),/mismatch/);
  assert.deepEqual(f.storage.snapshot(),before);
});

test("concurrent owners cannot commit competing signed transitions",async()=>{
  const f=await setup([REMOVED,ACTIVE,OTHER]);
  const one=await f.prepare(REMOVED);
  const two=await f.prepare(OTHER);
  const result=await Promise.allSettled([
    publishAtomicRotation(f.storage,one),
    publishAtomicRotation(f.storage,two),
  ]);
  assert.equal(result.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(result.filter(x=>x.status==="rejected").length,1);
  const ledger=await readMembershipEvents(f.storage);
  assert.equal(ledger.length,5); // genesis + 3 joins + exactly one rotation
  const verified=await verifyMembershipHistory(ledger,f.owner.publicKeyJwk);
  assert.equal(verified.epoch,2);
});

test("a failing final fence write rolls back keys, history, and membership atomically",async()=>{
  const f=await setup();
  const prepared=await f.prepare();
  const before=f.storage.snapshot();
  const broken={
    transaction:fn=>f.storage.transaction(async tx=>{
      const put=tx.put.bind(tx);
      tx.put=async(key,value)=>{
        if(key==="rekey:epoch-fence")throw Error("simulated write failure");
        return put(key,value);
      };
      return fn(tx);
    }),
  };
  await assert.rejects(publishAtomicRotation(broken,prepared),/write failure/);
  assert.deepEqual(f.storage.snapshot(),before);
  await publishAtomicRotation(f.storage,prepared);
  assert.equal((await f.storage.get("membership:state")).epoch,2);
});

test("future and old epoch writes and revoked member writes fail the same-transaction fence",async()=>{
  const f=await setup();
  await f.storage.transaction(tx=>assertCurrentEpochAppend(tx,{
    listId:LIST,memberId:ACTIVE,epoch:1}));
  await publishAtomicRotation(f.storage,await f.prepare());
  await f.storage.transaction(tx=>assertCurrentEpochAppend(tx,{
    listId:LIST,memberId:ACTIVE,epoch:2}));
  await assert.rejects(f.storage.transaction(tx=>assertCurrentEpochAppend(tx,{
    listId:LIST,memberId:ACTIVE,epoch:1})),/stale/);
  await assert.rejects(f.storage.transaction(tx=>assertCurrentEpochAppend(tx,{
    listId:LIST,memberId:ACTIVE,epoch:3})),/future/);
  await assert.rejects(f.storage.transaction(tx=>assertCurrentEpochAppend(tx,{
    listId:LIST,memberId:REMOVED,epoch:2})),/revoked/);
});

test("owner-only list can rotate without recipient packages",async()=>{
  const f=await setup([REMOVED]);
  const prepared=await f.prepare();
  assert.deepEqual(prepared.envelopes,[]);
  const result=await publishAtomicRotation(f.storage,prepared);
  assert.deepEqual(result.recipients,[]);
  assert.equal(result.publication,"published");
  assert.equal((await f.storage.get("membership:state")).epoch,2);
  await assert.rejects(readCurrentKeyPackage(f.storage,{listId:LIST,memberId:REMOVED}));
});

test("failed or repeated signed rotation never overwrites a published envelope",async()=>{
  const f=await setup();
  const prepared=await f.prepare();
  await publishAtomicRotation(f.storage,prepared);
  const snapshot=f.storage.snapshot();
  await assert.rejects(publishAtomicRotation(f.storage,prepared),/rotation/);
  assert.deepEqual(f.storage.snapshot(),snapshot);
});
