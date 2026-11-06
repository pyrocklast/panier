// Experimental Panier v2 trust anchors and anti-rollback checkpoints.
// Owner root MUST be pinned locally before the first network bootstrap.
// Recipient root MUST come from the owner-verified physical QR, never from
// an untrusted list-history response. This does not prove server freshness.
import { signGenesis, verifyMembershipHistory, membershipEventHash } from "./membership-ledger.mjs";
import { openQrKeyPackage } from "./qr-pairing.mjs";

const DEFAULT_DB="panier-v2-trust";
const STORE="anchors";
const VERSION=1;
const ID=/^[A-Za-z0-9_-]{8,64}$/;
const assert=(valid,message)=>{if(!valid)throw new TrustFailure(message);};
const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const sameKey=(a,b)=>isObject(a)&&isObject(b)&&
  a.kty==="EC"&&b.kty==="EC"&&a.crv==="P-256"&&b.crv==="P-256"&&
  a.x===b.x&&a.y===b.y;
const normalizeKey=k=>{
  assert(isObject(k)&&k.kty==="EC"&&k.crv==="P-256"&&
    typeof k.x==="string"&&typeof k.y==="string","invalid trusted owner key");
  return {kty:"EC",crv:"P-256",x:k.x,y:k.y};
};

export class TrustFailure extends Error {
  constructor(message,cause){
    super(message,{cause});
    this.name="TrustFailure";
  }
}

/** Separate DB from the optimistic plaintext list cache. Never auto-TOFU. */
export function openTrustDatabase({name=DEFAULT_DB}={}){
  assert(typeof indexedDB!=="undefined","IndexedDB is unavailable");
  assert(typeof name==="string"&&name.length>=1&&name.length<=120,"invalid trust database name");
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(name,VERSION);
    let settled=false;
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE,{keyPath:"listId"});
    };
    request.onerror=()=>{
      if(!settled){settled=true;reject(new TrustFailure("unable to open trust database",request.error));}
    };
    request.onblocked=()=>{
      if(!settled){settled=true;reject(new TrustFailure("trust database upgrade blocked"));}
    };
    request.onsuccess=()=>{
      const db=request.result;
      db.onversionchange=()=>db.close();
      if(settled){db.close();return;}
      settled=true;resolve(db);
    };
  });
}

/**
 * IDB reads/writes are enqueued synchronously in request callbacks.
 * No crypto/network promise is awaited inside a transaction. All writes
 * complete before the operation reports success, across browser tabs.
 */
function transact(db,listId,action,mode="readwrite"){
  assert(db&&typeof db.transaction==="function"&&typeof listId==="string"&&
    ID.test(listId),"invalid trusted list");
  return new Promise((resolve,reject)=>{
    let transaction,failed=null,result;
    try{
      transaction=db.transaction(STORE,mode);
      const store=transaction.objectStore(STORE);
      const request=store.get(listId);
      request.onsuccess=()=>{
        try{
          const outcome=action(request.result,store);
          result=outcome;
        }catch(error){
          failed=error;
          try{transaction.abort();}catch(_){}
        }
      };
      transaction.oncomplete=()=>resolve(result);
      transaction.onabort=()=>reject(failed||new TrustFailure(
        "trust update aborted",transaction.error));
      transaction.onerror=()=>{}; // onabort handles transaction errors
    }catch(error){reject(new TrustFailure("trust transaction failed",error));}
  });
}
const checkpoint=state=>({sequence:state.sequence,head:state.head,epoch:state.epoch});
function publicAnchor(row){
  if(!row)return null;
  return {listId:row.listId,ownerId:row.ownerId,
    ownerPublicJwk:normalizeKey(row.ownerPublicJwk),
    source:row.source,checkpoint:{...row.checkpoint}};
}
export async function readPinnedTrust(db,listId){
  return transact(db,listId,row=>publicAnchor(row),"readonly");
}
export async function readLocalOwnerSigningKey(db,listId){
  return transact(db,listId,row=>{
    assert(row&&row.source==="owner-local"&&row.signingPrivateKey instanceof CryptoKey,
      "owner signing identity is unavailable; use reviewed recovery");
    assert(row.signingPrivateKey.type==="private"&&!row.signingPrivateKey.extractable,
      "unsafe owner signing key");
    return row.signingPrivateKey;
  },"readonly");
}
function saveOnce(db,row){
  return transact(db,row.listId,(existing,store)=>{
    assert(!existing,"trust anchor already pinned; refusing replacement");
    store.add(row);
    return publicAnchor(row);
  });
}

/**
 * Explicit local owner creation flow:
 * 1. Generate anonymous nonextractable signing identity on device.
 * 2. Sign genesis, validate the signature against THAT same public key.
 * 3. Durably save both signing CryptoKey and root checkpoint.
 * 4. Only THEN POST genesis to Cloudflare. On network failure keep the root
 *    for verified reconciliation; never generate a replacement for same ID.
 */
export async function pinNewOwnerBeforeBootstrap(db,{listId,identity}){
  assert(typeof listId==="string"&&ID.test(listId)&&
    identity&&typeof identity.actorId==="string"&&
    identity.privateKey instanceof CryptoKey&&
    identity.privateKey.type==="private"&&
    identity.privateKey.extractable===false&&
    identity.privateKey.algorithm.name==="ECDSA"&&
    identity.privateKey.algorithm.namedCurve==="P-256",
    "invalid local owner signing identity");
  const root=normalizeKey(identity.publicKeyJwk);
  const event=await signGenesis({listId,ownerId:identity.actorId,
    ownerPublicJwk:root,privateKey:identity.privateKey});
  const state=await verifyMembershipHistory([event],root); // catch mismatched keypair
  assert(state.listId===listId&&state.ownerId===identity.actorId,
    "genesis not bound to local owner");
  const trust=await saveOnce(db,{
    listId,ownerId:identity.actorId,ownerPublicJwk:root,
    source:"owner-local",checkpoint:checkpoint(state),
    signingPrivateKey:identity.privateKey,
  });
  return {event,trust};
}

/**
 * The physical QR authenticates the owner public-key fingerprint and a
 * signed encrypted invitation. Only that QR-authorized key may become the
 * recipient's root; the server's genesis history cannot choose the root.
 * The QR secret is returned for the enrollment flow but NEVER stored here.
 */
export async function pinOwnerFromScannedQr(db,{qr,serverRecord,events,now=Date.now()}){
  const imported=await openQrKeyPackage({qr,serverRecord,now});
  assert(serverRecord&&serverRecord.listId===imported.listId&&
    serverRecord.ownerId===imported.ownerId,
    "QR owner and invitation mismatch");
  const root=normalizeKey(serverRecord.ownerPublicJwk);
  const state=await verifyMembershipHistory(events,root);
  assert(state.listId===imported.listId&&state.ownerId===imported.ownerId&&
    state.epoch===imported.epoch,
    "QR cannot authenticate the supplied membership history");
  const trust=await saveOnce(db,{
    listId:imported.listId,ownerId:imported.ownerId,ownerPublicJwk:root,
    source:"physical-qr",checkpoint:checkpoint(state),
  });
  return {trust,listSecret:imported.listSecret};
}

/**
 * Pure verification of an authenticated complete history against an EXISTING
 * root and checkpoint. Rejects shorter history, different same-sequence
 * heads, bad signatures, wrong owner/list and forked extensions.
 */
export async function verifyTrustedHistory(anchor,events){
  assert(anchor&&anchor.checkpoint&&typeof anchor.listId==="string"&&
    typeof anchor.ownerId==="string"&&Array.isArray(events),
    "no locally pinned trust anchor");
  const state=await verifyMembershipHistory(events,anchor.ownerPublicJwk);
  assert(state.listId===anchor.listId&&state.ownerId===anchor.ownerId,
    "membership history belongs to a different owner or list");
  const saved=anchor.checkpoint;
  assert(Number.isSafeInteger(saved.sequence)&&saved.sequence>=1&&
    typeof saved.head==="string"&&Number.isSafeInteger(saved.epoch)&&saved.epoch>=1,
    "invalid saved membership checkpoint");
  assert(state.sequence>=saved.sequence,
    "membership rollback detected: history shorter than pinned checkpoint");
  const prefixHead=await membershipEventHash(events[saved.sequence-1]);
  assert(prefixHead===saved.head,
    "membership fork or rollback detected: pinned checkpoint changed");
  assert(state.epoch>=saved.epoch,
    "membership key epoch regressed");
  return state;
}

/**
 * Race-safe checkpoint update. Verification happens BEFORE opening an IDB
 * transaction. Every event's digest is prepared so any other tab's newer
 * checkpoint can be checked without awaiting crypto inside the transaction.
 */
export async function advancePinnedMembership(db,listId,events){
  const initial=await readPinnedTrust(db,listId);
  assert(initial,"unrecognized list: require local owner or physical QR pinning");
  const state=await verifyTrustedHistory(initial,events);
  const prefixHeads=await Promise.all(events.map(event=>membershipEventHash(event)));
  return transact(db,listId,(row,store)=>{
    assert(row&&sameKey(row.ownerPublicJwk,initial.ownerPublicJwk)&&
      row.ownerId===initial.ownerId&&row.source===initial.source,
      "trusted root was replaced during verification");
    const saved=row.checkpoint;
    assert(Number.isSafeInteger(saved.sequence)&&saved.sequence>=1&&
      saved.sequence<=state.sequence,"membership history rollback during update");
    assert(prefixHeads[saved.sequence-1]===saved.head,
      "concurrent membership fork or rollback detected");
    assert(state.epoch>=saved.epoch,
      "membership epoch regressed during update");
    if(state.sequence>saved.sequence)
      store.put({...row,checkpoint:checkpoint(state)});
    return publicAnchor(state.sequence>saved.sequence?
      {...row,checkpoint:checkpoint(state)}:row);
  });
}
