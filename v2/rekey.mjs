// Panier v2 experimental post-revocation key distribution.
// ISOLATED: no network, persistence, or production integration.
// Recipient ECDH keys MUST be authenticated against an owner-signed,
// client-verified membership record (not the server's asserted key).

const te = new TextEncoder();
const td = new TextDecoder("utf-8",{fatal:true});
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const check=(p,m)=>{if(!p)throw new TypeError(m);};
const object=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const exact=(x,ks)=>object(x)&&Object.keys(x).sort().join(",")===ks.slice().sort().join(",");
const id=x=>typeof x==="string"&&ID.test(x);
const encode=x=>te.encode(JSON.stringify(x));
const b64=bytes=>{
  const v=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  let s="";for(let i=0;i<v.length;i+=4096)s+=String.fromCharCode(...v.subarray(i,i+4096));
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
};
const unb64=(s,max=10000)=>{
  check(typeof s==="string"&&s.length>0&&s.length<=max&&/^[A-Za-z0-9_-]+$/.test(s),"invalid encoding");
  const bytes=Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
  check(b64(bytes)===s,"noncanonical base64url");
  return bytes;
};
const publicJwk=k=>{
  check(object(k)&&k.kty==="EC"&&k.crv==="P-256"&&
    typeof k.x==="string"&&typeof k.y==="string"&&
    unb64(k.x,64).length===32&&unb64(k.y,64).length===32,
    "invalid P-256 ECDH public key");
  return {kty:"EC",crv:"P-256",x:k.x,y:k.y};
};
const compare=(a,b)=>JSON.stringify(publicJwk(a))===JSON.stringify(publicJwk(b));
const wireFields=["v","listId","epoch","rotationHead","ownerId","memberId",
  "ephemeralPublicJwk","nonce","ciphertext"];
const body=({listId,epoch,rotationHead,ownerId,memberId,ephemeralPublicJwk,nonce,ciphertext})=>
  ({v:1,listId,epoch,rotationHead,ownerId,memberId,
    ephemeralPublicJwk:publicJwk(ephemeralPublicJwk),nonce,ciphertext});
const context=({listId,epoch,rotationHead,ownerId,memberId,ephemeralPublicJwk})=>
  ({v:1,purpose:"panier/v2/rekey/key-envelope/1",listId,epoch,rotationHead,
    ownerId,memberId,ephemeralPublicJwk:publicJwk(ephemeralPublicJwk)});
async function importEcdh(k) {
  return crypto.subtle.importKey("jwk",publicJwk(k),
    {name:"ECDH",namedCurve:"P-256"},false,[]);
}
async function derived(privateKey,publicKey,details) {
  const shared=await crypto.subtle.deriveBits(
    {name:"ECDH",public:publicKey},privateKey,256);
  const root=await crypto.subtle.importKey("raw",shared,"HKDF",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",
    salt:te.encode("panier/v2/rekey:"+details.listId+":"+details.epoch),
    info:encode(context(details))},root,
    {name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function sign(privateKey,payload) {
  check(privateKey instanceof CryptoKey&&privateKey.type==="private"&&
    privateKey.algorithm.name==="ECDSA"&&
    privateKey.algorithm.namedCurve==="P-256","invalid owner signing key");
  return b64(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},privateKey,encode(payload)));
}
async function verify(publicKey,signature,payload) {
  check(publicKey instanceof CryptoKey&&publicKey.type==="public"&&
    publicKey.algorithm.name==="ECDSA","invalid trusted owner signing key");
  const sig=unb64(signature,128);
  check(sig.length===64,"invalid P-256 signature");
  return crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},publicKey,sig,encode(payload));
}
const validHead=s=>typeof s==="string"&&unb64(s,64).length===32;

/** Separate encryption key from signing identity, per browser/device. */
export async function generateRecipientAgreementKey() {
  const keys=await crypto.subtle.generateKey(
    {name:"ECDH",namedCurve:"P-256"},false,["deriveBits"]);
  return {
    privateKey:keys.privateKey,
    publicKey:keys.publicKey,
    publicJwk:publicJwk(await crypto.subtle.exportKey("jwk",keys.publicKey)),
  };
}

/**
 * Owner creates ONE package per retained member; removed member gets none.
 * trustedRecipients MUST originate from a signed and verified membership
 * snapshot with an authenticated ECDH key bound to each active member.
 * The caller must verify rotationHead belongs to a signed epoch transition.
 */
export async function sealRotatedKeyPackages({
  listId,ownerId,epoch,rotationHead,ownerSigningKey,listSecret,
  trustedRecipients,removedMemberId,
}) {
  check(id(listId)&&id(ownerId)&&id(removedMemberId)&&
    Number.isSafeInteger(epoch)&&epoch>=2&&validHead(rotationHead)&&
    listSecret instanceof Uint8Array&&listSecret.length===32&&
    Array.isArray(trustedRecipients)&&trustedRecipients.length>=1&&
    trustedRecipients.length<=64,"invalid rotated-key context");
  const used=new Set(),result=[];
  for(const member of trustedRecipients) {
    check(object(member)&&id(member.memberId)&&
      member.memberId!==removedMemberId&&!used.has(member.memberId),
      "removed or duplicated member in distribution");
    used.add(member.memberId);
    const memberKey=await importEcdh(member.agreementPublicJwk);
    const eph=await crypto.subtle.generateKey(
      {name:"ECDH",namedCurve:"P-256"},false,["deriveBits"]);
    const ephemeralPublicJwk=publicJwk(
      await crypto.subtle.exportKey("jwk",eph.publicKey));
    const metadata={listId,epoch,rotationHead,ownerId,
      memberId:member.memberId,ephemeralPublicJwk};
    const key=await derived(eph.privateKey,memberKey,metadata);
    const nonce=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=b64(await crypto.subtle.encrypt({
      name:"AES-GCM",iv:nonce,additionalData:encode(context(metadata)),
      tagLength:128,
    },key,listSecret));
    const unsigned=body({...metadata,nonce:b64(nonce),ciphertext});
    result.push({...unsigned,signature:await sign(ownerSigningKey,unsigned)});
  }
  return result;
}

/**
 * Recipient verifies an owner-signed package and a trusted, pinned membership
 * head + recipient ECDH binding before decrypting. NO server-supplied key
 * substitutions, no implicit downgrade to an older epoch.
 */
export async function openRotatedKeyPackage({
  envelope,listId,memberId,currentEpoch,rotationHead,
  trustedOwnerSigningKey,recipientAgreementPrivateKey,
}) {
  check(object(envelope)&&exact(envelope,[...wireFields,"signature"])&&
    id(listId)&&id(memberId)&&Number.isSafeInteger(currentEpoch)&&
    currentEpoch>=2&&validHead(rotationHead),"invalid rekey envelope");
  check(envelope.v===1&&envelope.listId===listId&&
    envelope.memberId===memberId&&envelope.epoch===currentEpoch&&
    envelope.rotationHead===rotationHead&&id(envelope.ownerId),
    "rekey envelope does not match trusted membership checkpoint");
  check(recipientAgreementPrivateKey instanceof CryptoKey&&
    recipientAgreementPrivateKey.type==="private"&&
    recipientAgreementPrivateKey.algorithm.name==="ECDH","invalid recipient key");
  const unsigned=body(envelope);
  check(await verify(trustedOwnerSigningKey,envelope.signature,unsigned),
    "invalid rekey owner signature");
  const nonce=unb64(envelope.nonce,64);
  check(nonce.length===12,"invalid rekey nonce");
  const encrypted=unb64(envelope.ciphertext,256);
  check(encrypted.length===48,"invalid rekey ciphertext size");
  const key=await derived(recipientAgreementPrivateKey,
    await importEcdh(envelope.ephemeralPublicJwk),envelope);
  const plaintext=await crypto.subtle.decrypt({
    name:"AES-GCM",iv:nonce,additionalData:encode(context(envelope)),
    tagLength:128,
  },key,encrypted);
  const newSecret=new Uint8Array(plaintext);
  check(newSecret.length===32,"invalid rekey material");
  return newSecret;
}

/** The signed mutation envelope exposes epoch without exposing plaintext. */
export function sealedMutationEpoch(sealed) {
  check(object(sealed)&&typeof sealed.ciphertext==="string"&&
    sealed.ciphertext.length<=24*1024,"invalid sealed mutation");
  const raw=unb64(sealed.ciphertext,24*1024);
  const parsed=JSON.parse(td.decode(raw));
  check(object(parsed)&&Number.isSafeInteger(parsed.epoch)&&parsed.epoch>=1,
    "mutation epoch missing");
  return parsed.epoch;
}

/**
 * Never automatically upload or silently re-encrypt stale signed operations.
 * Retain the original immutable outbox record until a reviewed rebase policy
 * generates a NEW mutation ID, ciphertext and authorized epoch.
 */
export function classifyPendingEpochs(pending,currentEpoch) {
  check(Array.isArray(pending)&&Number.isSafeInteger(currentEpoch)&&currentEpoch>=1,
    "invalid epoch reconciliation");
  const ready=[],quarantined=[];
  for(const entry of pending) {
    check(object(entry)&&id(entry.id)&&object(entry.sealed),
      "missing immutable sealed pending mutation");
    const epoch=sealedMutationEpoch(entry.sealed);
    if(epoch===currentEpoch)ready.push(entry);
    else if(epoch<currentEpoch)quarantined.push({
      id:entry.id,epoch,reason:"stale-epoch-requires-rebase",
    });
    else throw new TypeError("future epoch pending mutation");
  }
  return {ready,quarantined};
}
