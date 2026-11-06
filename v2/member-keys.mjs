// Panier v2: local, non-extractable member signing + ECDH key persistence.
// No network, recovery service or production PWA integration. Private keys
// remain invocable by same-origin JS: this is durability, not XSS protection.
import { readPinnedTrust,verifyTrustedHistory,advancePinnedMembership } from "./trust.mjs";

const STORE="devices",DB_VERSION=1,DEFAULT_NAME="panier-v2-member-keys";
const ID=/^[A-Za-z0-9_-]{8,64}$/;
const validId=x=>typeof x==="string"&&ID.test(x);
const guard=(value,message)=>{if(!value)throw new Error(message);};
const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const normalized=k=>{
  guard(isObject(k)&&k.kty==="EC"&&k.crv==="P-256"&&
    typeof k.x==="string"&&typeof k.y==="string",
    "invalid device public key");
  return {kty:"EC",crv:"P-256",x:k.x,y:k.y};
};
const equalKey=(a,b)=>isObject(a)&&isObject(b)&&
  a.kty==="EC"&&b.kty==="EC"&&a.crv==="P-256"&&b.crv==="P-256"&&
  a.x===b.x&&a.y===b.y;
const privateKey=(k,algorithm)=>k instanceof CryptoKey&&
  k.type==="private"&&k.extractable===false&&
  k.algorithm.name===algorithm&&k.algorithm.namedCurve==="P-256";

export function openMemberKeyDatabase({name=DEFAULT_NAME}={}){
  guard(typeof indexedDB!=="undefined"&&typeof name==="string"&&
    name.length>0&&name.length<=120,"invalid device-key database");
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(name,DB_VERSION);
    let settled=false;
    req.onupgradeneeded=()=>{
      if(!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE,{keyPath:"listId"});
    };
    req.onblocked=()=>{if(!settled){settled=true;reject(Error("device-key DB upgrade blocked"));}};
    req.onerror=()=>{if(!settled){settled=true;reject(req.error||Error("cannot open device keys"));}};
    req.onsuccess=()=>{
      const db=req.result;
      db.onversionchange=()=>db.close();
      if(settled){db.close();return;}
      settled=true;resolve(db);
    };
  });
}

/** IndexedDB transaction contains only synchronous request callbacks. */
function transact(db,listId,action,mode="readwrite"){
  guard(db&&typeof db.transaction==="function"&&validId(listId),
    "invalid device-key transaction");
  return new Promise((resolve,reject)=>{
    let tx,returned,failed=null;
    try{
      tx=db.transaction(STORE,mode);
      const store=tx.objectStore(STORE),request=store.get(listId);
      request.onsuccess=()=>{
        try{returned=action(request.result,store);}
        catch(error){failed=error;try{tx.abort();}catch(_){}}
      };
      tx.oncomplete=()=>resolve(returned);
      tx.onabort=()=>reject(failed||tx.error||Error("device-key transaction aborted"));
    }catch(error){reject(error);}
  });
}

/** Local proof that a non-extractable private ECDH key matches its public key. */
export async function verifyAgreementKeyPair(agreement){
  guard(agreement&&privateKey(agreement.privateKey,"ECDH"),
    "invalid private agreement key");
  const registered=await crypto.subtle.importKey("jwk",normalized(agreement.publicJwk),
    {name:"ECDH",namedCurve:"P-256"},false,[]);
  const ephemeral=await crypto.subtle.generateKey({
    name:"ECDH",namedCurve:"P-256"},false,["deriveBits"]);
  const a=new Uint8Array(await crypto.subtle.deriveBits(
    {name:"ECDH",public:registered},ephemeral.privateKey,256));
  const b=new Uint8Array(await crypto.subtle.deriveBits(
    {name:"ECDH",public:ephemeral.publicKey},agreement.privateKey,256));
  let delta=0;
  for(let i=0;i<32;i++)delta|=a[i]^b[i];
  guard(delta===0,"agreement private/public key mismatch");
  return true;
}
async function verifySigningKeyPair(identity){
  guard(identity&&validId(identity.actorId)&&
    privateKey(identity.privateKey,"ECDSA"),
    "invalid member signing identity");
  const publicKey=await crypto.subtle.importKey("jwk",
    normalized(identity.publicKeyJwk),
    {name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  const challenge=crypto.getRandomValues(new Uint8Array(32));
  const sig=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},
    identity.privateKey,challenge);
  guard(await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},
    publicKey,sig,challenge),"member signing private/public key mismatch");
}
function publicInfo(row){
  if(!row)return null;
  return {listId:row.listId,memberId:row.memberId,
    signingPublicJwk:normalized(row.signingPublicJwk),
    agreementPublicJwk:normalized(row.agreementPublicJwk)};
}

/**
 * Persist BOTH generated device keypairs before submitting a QR claim.
 * Requires an owner-authenticated physical QR trust anchor to already exist.
 * This prevents a lost response or browser restart from replacing keys
 * under the same list/member identity. QR seed/epoch secret is NOT stored.
 */
export async function saveNewMemberKeys({db,trustDb,listId,identity,agreement}){
  guard(validId(listId),"invalid list ID");
  const anchor=await readPinnedTrust(trustDb,listId);
  guard(anchor&&anchor.source==="physical-qr",
    "recipient requires physical QR owner trust before persisting keys");
  await verifySigningKeyPair(identity);
  await verifyAgreementKeyPair(agreement);
  const row={
    listId,memberId:identity.actorId,
    ownerId:anchor.ownerId,ownerPublicJwk:normalized(anchor.ownerPublicJwk),
    signingPublicJwk:normalized(identity.publicKeyJwk),
    agreementPublicJwk:normalized(agreement.publicJwk),
    signingPrivateKey:identity.privateKey,
    agreementPrivateKey:agreement.privateKey,
  };
  return transact(db,listId,(existing,store)=>{
    guard(!existing,"member keys already saved; refuse key replacement");
    store.add(row);
    return publicInfo(row);
  });
}

async function readForAnchor(db,trustDb,listId){
  const anchor=await readPinnedTrust(trustDb,listId);
  guard(anchor&&anchor.source==="physical-qr","no trusted recipient owner root");
  const row=await transact(db,listId,stored=>stored,"readonly");
  guard(row&&row.ownerId===anchor.ownerId&&
    equalKey(row.ownerPublicJwk,anchor.ownerPublicJwk)&&
    privateKey(row.signingPrivateKey,"ECDSA")&&
    privateKey(row.agreementPrivateKey,"ECDH"),
    "local device credentials missing, unsafe, or bound to another owner");
  return {anchor,row};
}

/**
 * For an uncertain QR response ONLY. Does not assert membership or authorize
 * sync. A new enrollment attempt must re-prove keys and verify the signed
 * join history; the QR seed, if needed, must still come from a trusted scan.
 */
export async function readPendingMemberKeys({db,trustDb,listId}){
  const {row}=await readForAnchor(db,trustDb,listId);
  return {...publicInfo(row),
    signingPrivateKey:row.signingPrivateKey,
    agreementPrivateKey:row.agreementPrivateKey};
}

/**
 * Active identity lookup must verify and persist the full owner-pinned
 * membership chain, then compare BOTH independently registered public keys
 * to the local non-extractable private keys. Removed devices fail closed.
 */
export async function readAuthorizedMemberKeys({db,trustDb,listId,events}){
  const {anchor,row}=await readForAnchor(db,trustDb,listId);
  const verified=await verifyTrustedHistory(anchor,events);
  const member=verified.members.find(m=>m.memberId===row.memberId&&
    m.active===true&&m.role==="member");
  guard(member&&equalKey(member.publicJwk,row.signingPublicJwk)&&
    equalKey(member.agreementPublicJwk,row.agreementPublicJwk),
    "local member not authorized by owner-signed membership history");
  await advancePinnedMembership(trustDb,listId,events);
  return {...publicInfo(row),epoch:verified.epoch,
    signingPrivateKey:row.signingPrivateKey,
    agreementPrivateKey:row.agreementPrivateKey};
}
