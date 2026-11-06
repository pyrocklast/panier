// Panier v2 — isolated atomic post-revocation epoch publication.
// One Durable Object per list. No HTTP routes, deployment or v1 code.
// Owner PREPARES all signed ciphertext before the transaction; storage
// transaction commits signed rotation, recipient envelopes and append fence.
// This does not authenticate client fetch requests or prove server freshness.
import { previewSignedRotation } from "./membership-ledger.mjs";
import { verifySignedRotatedKeyPackage } from "./rekey.mjs";
import { importMemberPublicKey } from "./crypto.mjs";

const ROOT="membership:state";
const ID=/^[A-Za-z0-9_-]{8,64}$/;
const validId=value=>typeof value==="string"&&ID.test(value);
const requireThat=(condition,message)=>{if(!condition)throw new TypeError(message);};
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const eventKey=sequence=>"membership:event:"+String(sequence).padStart(12,"0");
const packageKey=(epoch,memberId)=>"rekey:package:"+epoch+":"+memberId;
const manifestKey=head=>"rekey:manifest:"+head;
const FENCE="rekey:epoch-fence";

function recipientsAfterRotation(preview,event) {
  const recipients=preview.members.filter(member=>member.active&&member.role==="member");
  requireThat(recipients.length<=64,"too many remaining members");
  requireThat(recipients.every(member=>member.memberId!==event.removedMemberId &&
    object(member.agreementPublicJwk)),"missing authenticated member ECDH key");
  return recipients;
}

/**
 * Client prepares a signed rotation event against the last verified ledger
 * checkpoint, predicts its hash via previewSignedRotation(), and encrypts
 * envelopes to ALL active surviving members under that exact future head.
 * Before submission it MUST pin/verify the membership history itself.
 *
 * Server rechecks the signed event, complete recipient set and signatures
 * against the CURRENT state INSIDE the transaction. If either parent head
 * or any envelope is missing/wrong, NOTHING changes.
 *
 * A single-owner list may have zero envelopes, because the owner generated
 * and retained the new key locally. This is an explicit supported case.
 */
export async function publishAtomicRotation(storage,{event,envelopes}) {
  requireThat(storage&&typeof storage.transaction==="function"&&
    object(event)&&Array.isArray(envelopes),"invalid atomic rotation request");
  requireThat(envelopes.length<=64,"too many rotation packages");
  return storage.transaction(async tx=>{
    const state=await tx.get(ROOT);
    requireThat(state,"membership ledger uninitialised");
    const next=await previewSignedRotation(state,event); // checks signature, owner, epoch and head
    const recipients=recipientsAfterRotation(next,event);
    requireThat(envelopes.length===recipients.length,
      "incomplete key distribution; rotation not committed");
    const byMember=new Map();
    for(const envelope of envelopes) {
      requireThat(object(envelope)&&validId(envelope.memberId)&&
        !byMember.has(envelope.memberId),"duplicate or invalid recipient package");
      byMember.set(envelope.memberId,envelope);
    }
    const ownerKey=await importMemberPublicKey(state.ownerPublicJwk);
    for(const member of recipients) {
      const envelope=byMember.get(member.memberId);
      requireThat(envelope,"missing required recipient key package");
      await verifySignedRotatedKeyPackage({
        envelope,listId:state.listId,ownerId:state.ownerId,
        memberId:member.memberId,epoch:next.epoch,rotationHead:next.head,
        recipientAgreementPublicJwk:member.agreementPublicJwk,
        trustedOwnerSigningKey:ownerKey,
      });
    }
    requireThat(!await tx.get(eventKey(next.sequence)) &&
      !await tx.get(manifestKey(next.head)),
      "rotation already exists");
    // All validation runs BEFORE the first write. Storage still rolls back
    // every write if any later write fails, including the final fence update.
    const memberIds=recipients.map(member=>member.memberId).sort();
    for(const memberId of memberIds) {
      const slot=packageKey(next.epoch,memberId);
      requireThat(!await tx.get(slot),"epoch key package already published");
      await tx.put(slot,byMember.get(memberId));
    }
    await tx.put(eventKey(next.sequence),event);
    await tx.put(ROOT,next);
    await tx.put(manifestKey(next.head),{
      v:1,listId:state.listId,ownerId:state.ownerId,
      sequence:next.sequence,epoch:next.epoch,head:next.head,
      memberIds,status:"published", // NOT delivery confirmation
    });
    // Append endpoints MUST check this fence inside their append transaction.
    await tx.put(FENCE,{listId:state.listId,epoch:next.epoch,
      head:next.head,sequence:next.sequence});
    return {listId:state.listId,epoch:next.epoch,head:next.head,
      recipients:memberIds,publication:"published"};
  });
}

/**
 * Reads only the CURRENT epoch's package for an active member. The caller
 * MUST authenticate the requesting member's signing identity separately.
 * No recipient private key, epoch secret, or decryption seed is held here.
 * An offline member can fetch this after publication without the owner online.
 */
export async function readCurrentKeyPackage(storage,{listId,memberId}) {
  requireThat(storage&&typeof storage.get==="function"&&
    validId(listId)&&validId(memberId),"invalid package request");
  const state=await storage.get(ROOT);
  requireThat(state&&state.listId===listId,"membership ledger unavailable");
  const member=state.members.find(m=>m.memberId===memberId);
  requireThat(member&&member.active&&member.role==="member",
    "requester is not an active member");
  // New members may join AFTER an epoch was published, advancing the
  // membership log head. Ciphertexts must remain pinned to the original
  // rotation head, not to the newest join event's hash.
  const fence=await storage.get(FENCE);
  requireThat(fence&&fence.listId===listId&&fence.epoch===state.epoch&&
    Number.isSafeInteger(fence.sequence)&&fence.sequence<=state.sequence,
    "current epoch publication fence unavailable");
  const manifest=await storage.get(manifestKey(fence.head));
  requireThat(manifest&&manifest.listId===listId&&
    manifest.epoch===state.epoch&&manifest.sequence===fence.sequence&&
    manifest.memberIds.includes(memberId),
    "current epoch package unavailable");
  const envelope=await storage.get(packageKey(state.epoch,memberId));
  requireThat(envelope&&envelope.memberId===memberId&&
    envelope.rotationHead===fence.head,
    "current epoch key package missing");
  return {envelope,manifest};
}

/**
 * Enforce write-epoch fencing in the SAME storage transaction as mutation
 * append. This is only a helper; the real append route must additionally
 * authenticate member signatures, mutation IDs and ciphertext.
 */
export async function assertCurrentEpochAppend(tx,{listId,memberId,epoch}) {
  requireThat(tx&&typeof tx.get==="function"&&validId(listId)&&
    validId(memberId)&&Number.isSafeInteger(epoch)&&epoch>=1,
    "invalid append authorization request");
  const state=await tx.get(ROOT);
  requireThat(state&&state.listId===listId&&state.epoch===epoch,
    "stale or future mutation epoch");
  const member=state.members.find(m=>m.memberId===memberId);
  requireThat(member&&member.active,
    "revoked or unknown member cannot append");
  if(epoch>1){
    const fence=await tx.get(FENCE);
    requireThat(fence&&fence.listId===listId&&fence.epoch===epoch&&
      Number.isSafeInteger(fence.sequence)&&fence.sequence<=state.sequence&&
      await tx.get(manifestKey(fence.head)),
      "new epoch was not fully published");
  }
  return {epoch,head:state.head};
}
