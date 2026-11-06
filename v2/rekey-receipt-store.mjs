// Panier v2: isolated durable forwarding of member-signed key-delivery
// receipts. The DO verifies the member signature and exact package binding,
// but CANNOT validate the secret-derived HMAC; only the owner can do so.
// "stored" is deliberately NOT named "confirmed".
import { importMemberPublicKey } from "./crypto.mjs";

const te=new TextEncoder();
const check=(v,message)=>{if(!v)throw new Error(message);};
const obj=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const exact=(v,ks)=>obj(v)&&Object.keys(v).sort().join(",")===ks.slice().sort().join(",");
const b64=bytes=>{
  const u=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  let binary="";for(let i=0;i<u.length;i+=4096)binary+=String.fromCharCode(...u.subarray(i,i+4096));
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
};
function unb64(value,length){
  check(typeof value==="string"&&value.length>0&&value.length<=128&&
    /^[A-Za-z0-9_-]+$/.test(value),"invalid receipt encoding");
  const bytes=Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")),
    ch=>ch.charCodeAt(0));
  check(bytes.length===length&&b64(bytes)===value,"invalid receipt encoding");
  return bytes;
}
const FENCE="rekey:epoch-fence";
const ROOT="membership:state";
const packageKey=(epoch,id)=>"rekey:package:"+epoch+":"+id;
const manifestKey=head=>"rekey:manifest:"+head;
const receiptKey=(epoch,id)=>"rekey:receipt:"+epoch+":"+id;
const signable=r=>({v:1,purpose:"panier/v2/rekey/receipt/1",
  listId:r.listId,epoch:r.epoch,rotationHead:r.rotationHead,
  ownerId:r.ownerId,memberId:r.memberId,packageHash:r.packageHash,proof:r.proof});
const fields=["v","purpose","listId","epoch","rotationHead","ownerId","memberId",
  "packageHash","proof","signature"];

async function packageHash(envelope){
  return b64(await crypto.subtle.digest("SHA-256",
    te.encode(JSON.stringify(envelope))));
}
async function currentPackage(tx,memberId){
  const state=await tx.get(ROOT);
  check(state&&Array.isArray(state.members),"membership ledger unavailable");
  const member=state.members.find(m=>m.memberId===memberId&&m.active&&m.role==="member");
  check(member&&member.publicJwk,"member cannot acknowledge rotation");
  const fence=await tx.get(FENCE);
  check(fence&&fence.epoch===state.epoch&&fence.listId===state.listId,
    "epoch is not currently published");
  const manifest=await tx.get(manifestKey(fence.head));
  check(manifest&&manifest.epoch===fence.epoch&&
    manifest.memberIds.includes(memberId),"member has no published package");
  const envelope=await tx.get(packageKey(state.epoch,memberId));
  check(envelope&&envelope.rotationHead===fence.head&&
    envelope.memberId===memberId&&envelope.listId===state.listId,
    "signed package missing");
  return {state,member,fence,manifest,envelope};
}

/**
 * The outer API request MUST first have passed signed member authentication.
 * Recheck membership and exact package in THIS same transaction before
 * storing. The inner member signature survives transport and retries.
 */
export async function storeSignedRekeyReceipt(storage,{listId,memberId,receipt}){
  check(storage&&typeof storage.transaction==="function"&&
    exact(receipt,fields)&&typeof listId==="string"&&
    memberId===receipt.memberId&&receipt.listId===listId,
    "invalid rekey receipt");
  check(receipt.v===1&&receipt.purpose==="panier/v2/rekey/receipt/1"&&
    Number.isSafeInteger(receipt.epoch)&&receipt.epoch>=2,
    "invalid rekey receipt version or epoch");
  const proof=unb64(receipt.proof,32);
  const signature=unb64(receipt.signature,64);
  unb64(receipt.packageHash,32);
  unb64(receipt.rotationHead,32);
  return storage.transaction(async tx=>{
    const {state,member,fence,envelope}=await currentPackage(tx,memberId);
    check(state.listId===listId&&state.ownerId===receipt.ownerId&&
      receipt.epoch===fence.epoch&&
      receipt.rotationHead===fence.head,"receipt does not match current rotation");
    check(receipt.packageHash===await packageHash(envelope),
      "receipt does not match exact signed ciphertext package");
    // Server can authenticate this signature but NOT the HMAC. The owner
    // must verify the secret-derived proof before confirming delivery.
    const signer=await importMemberPublicKey(member.publicJwk);
    check(await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},signer,
      signature,te.encode(JSON.stringify(signable(receipt)))),
      "invalid recipient receipt signature");
    const slot=receiptKey(receipt.epoch,memberId);
    const existing=await tx.get(slot);
    if(existing){
      // A retransmitted receipt can have a new ECDSA signature yet identical
      // signed content. This is safe idempotence, NOT owner confirmation.
      check(JSON.stringify(signable(existing))===JSON.stringify(signable(receipt)),
        "conflicting key delivery receipt already stored");
      return {listId,memberId,epoch:receipt.epoch,
        packageHash:receipt.packageHash,stored:true,duplicate:true,
        verifiedByOwner:false};
    }
    await tx.put(slot,receipt);
    return {listId,memberId,epoch:receipt.epoch,
      packageHash:receipt.packageHash,stored:true,duplicate:false,
      verifiedByOwner:false};
  });
}

/** Owner-authenticated request only; never return confirmations to strangers. */
export async function getStoredRekeyReceipts(storage,{listId}){
  check(storage&&typeof storage.transaction==="function","invalid storage");
  return storage.transaction(async tx=>{
    const state=await tx.get(ROOT);
    check(state&&state.listId===listId,"membership ledger unavailable");
    const fence=await tx.get(FENCE);
    if(!fence)return {listId,epoch:state.epoch,head:null,receipts:[]};
    check(fence.listId===listId&&fence.epoch===state.epoch,
      "epoch publication unavailable");
    const manifest=await tx.get(manifestKey(fence.head));
    check(manifest&&manifest.epoch===fence.epoch,
      "signed rotation manifest unavailable");
    const receipts=[];
    for(const memberId of manifest.memberIds){
      const receipt=await tx.get(receiptKey(fence.epoch,memberId));
      if(receipt)receipts.push(receipt);
    }
    return {listId,epoch:fence.epoch,head:fence.head,receipts,
      verifiedByOwner:false};
  });
}
