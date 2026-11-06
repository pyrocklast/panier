// Experimental append-only, signed Panier v2 membership ledger.
// Designed for one list per Durable Object, never wired into the v1 Worker.
// A trusted owner public key must be pinned client-side at bootstrap.
// Server-stored history alone is NOT proof of freshness or completeness.
import { enrollmentStatement } from "./qr-registry.mjs";

const te = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const validId = x => typeof x === "string" && ID.test(x);
const ok = (v,m) => { if(!v) throw new TypeError(m); };
const obj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x,fields) => obj(x) && Object.keys(x).sort().join(",") === [...fields].sort().join(",");
const sameKey = (a,b) => obj(a)&&obj(b)&&a.kty==="EC"&&b.kty==="EC"&&a.crv==="P-256"&&b.crv==="P-256"&&a.x===b.x&&a.y===b.y;
const publicJwk = k => {
  ok(obj(k)&&k.kty==="EC"&&k.crv==="P-256"&&typeof k.x==="string"&&typeof k.y==="string","invalid P-256 public key");
  return {kty:"EC",crv:"P-256",x:k.x,y:k.y};
};
const serialize = value => JSON.stringify(value);
function b64(v) {
  let out="";
  const data=v instanceof Uint8Array?v:new Uint8Array(v);
  for(let i=0;i<data.length;i+=4096)out+=String.fromCharCode(...data.subarray(i,i+4096));
  return btoa(out).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function unb64(value) {
  ok(typeof value==="string"&&value.length>0&&value.length<=256&&/^[A-Za-z0-9_-]+$/.test(value),"invalid signature");
  const bytes=Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
  ok(b64(bytes)===value,"noncanonical signature");
  return bytes;
}
async function digest(event) {
  return b64(await crypto.subtle.digest("SHA-256",te.encode(serialize(event))));
}
async function verify(jwk,signature,bytes) {
  const key=await crypto.subtle.importKey("jwk",publicJwk(jwk),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  return crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,unb64(signature),te.encode(bytes));
}
async function sign(privateKey,body) {
  ok(privateKey instanceof CryptoKey&&privateKey.type==="private"&&
    privateKey.algorithm.name==="ECDSA","invalid owner private key");
  return b64(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},privateKey,te.encode(serialize(body))));
}
const ROOT = "membership:state";
const eventKey = seq => "membership:event:"+String(seq).padStart(12,"0");
const genesisBody = ({listId,ownerId,ownerPublicJwk}) => ({
  v:1,kind:"genesis",listId,sequence:1,previous:null,
  ownerId,ownerPublicJwk:publicJwk(ownerPublicJwk),epoch:1,
});
const rotateBody = ({listId,sequence,previous,ownerId,epoch,removedMemberId}) => ({
  v:1,kind:"rotate",listId,sequence,previous,ownerId,epoch,removedMemberId,
});
const grantBody = g => ({
  v:g.v,listId:g.listId,inviteId:g.inviteId,ownerId:g.ownerId,
  epoch:g.epoch,expiresAt:g.expiresAt,tokenHash:g.tokenHash,
  fingerprint:g.fingerprint,nonce:g.nonce,ciphertext:g.ciphertext,
});
const joinBody = ({listId,sequence,previous,ownerId,epoch,inviteId,memberId,
  memberPublicJwk,agreementPublicJwk,nonce,proof,grant}) => ({
  v:2,kind:"join",listId,sequence,previous,ownerId,epoch,inviteId,
  memberId,memberPublicJwk:publicJwk(memberPublicJwk),
  agreementPublicJwk:publicJwk(agreementPublicJwk),nonce,proof,grant,
});

export async function signGenesis({listId,ownerId,ownerPublicJwk,privateKey}) {
  ok(validId(listId)&&validId(ownerId),"invalid genesis identifiers");
  const body=genesisBody({listId,ownerId,ownerPublicJwk});
  return {...body,signature:await sign(privateKey,body)};
}
export async function signRotation({listId,sequence,previous,ownerId,epoch,removedMemberId,privateKey}) {
  ok(validId(listId)&&validId(ownerId)&&validId(removedMemberId)&&
    Number.isSafeInteger(sequence)&&sequence>1&&Number.isSafeInteger(epoch)&&epoch>1&&
    typeof previous==="string","invalid rotation");
  const body=rotateBody({listId,sequence,previous,ownerId,epoch,removedMemberId});
  return {...body,signature:await sign(privateKey,body)};
}
async function checkGenesis(event, trustedOwnerKey) {
  ok(exact(event,["v","kind","listId","sequence","previous","ownerId","ownerPublicJwk","epoch","signature"])&&
    event.kind==="genesis"&&event.v===1&&event.sequence===1&&event.previous===null&&event.epoch===1&&
    validId(event.listId)&&validId(event.ownerId)&&sameKey(event.ownerPublicJwk,trustedOwnerKey),
    "untrusted or malformed owner genesis");
  ok(await verify(trustedOwnerKey,event.signature,serialize(genesisBody(event))),
    "invalid owner genesis signature");
}
async function checkRotation(event,state) {
  ok(exact(event,["v","kind","listId","sequence","previous","ownerId","epoch","removedMemberId","signature"])&&
    event.v===1&&event.kind==="rotate"&&event.listId===state.listId&&
    event.sequence===state.sequence+1&&event.previous===state.head&&
    event.ownerId===state.ownerId&&event.epoch===state.epoch+1&&
    validId(event.removedMemberId)&&event.removedMemberId!==state.ownerId&&
    state.members.some(m=>m.memberId===event.removedMemberId&&m.active),
    "stale or invalid membership rotation");
  ok(await verify(state.ownerPublicJwk,event.signature,serialize(rotateBody(event))),
    "invalid owner rotation signature");
}
async function checkJoin(event,state) {
  ok(exact(event,["v","kind","listId","sequence","previous","ownerId","epoch","inviteId",
    "memberId","memberPublicJwk","agreementPublicJwk","nonce","proof","grant"])&&
    event.v===2&&event.kind==="join"&&event.listId===state.listId&&
    event.sequence===state.sequence+1&&event.previous===state.head&&
    event.ownerId===state.ownerId&&event.epoch===state.epoch&&
    validId(event.inviteId)&&validId(event.memberId)&&
    !state.members.some(m=>m.memberId===event.memberId)&&
    !state.usedInvites.includes(event.inviteId)&&
    exact(event.grant,["v","listId","inviteId","ownerId","epoch",
      "expiresAt","tokenHash","fingerprint","nonce","ciphertext",
      "ownerPublicJwk","signature"])&&event.grant.v===1&&
    event.grant.listId===state.listId&&
    event.grant.inviteId===event.inviteId&&event.grant.ownerId===state.ownerId&&
    event.grant.epoch===state.epoch&&sameKey(event.grant.ownerPublicJwk,state.ownerPublicJwk),
    "invalid or replayed member enrollment");
  ok(await verify(state.ownerPublicJwk,event.grant.signature,serialize(grantBody(event.grant))),
    "invalid signed invitation grant");
  ok(await verify(event.memberPublicJwk,event.proof,enrollmentStatement({
    listId:event.listId,inviteId:event.inviteId,memberId:event.memberId,
    nonce:event.nonce,tokenHash:event.grant.tokenHash,
    agreementPublicJwk:event.agreementPublicJwk,
  })), "invalid recipient proof");
}
async function applied(state,event) {
  const head=await digest(event);
  if(event.kind==="genesis")return {
    v:1,listId:event.listId,ownerId:event.ownerId,
    ownerPublicJwk:publicJwk(event.ownerPublicJwk),epoch:1,
    sequence:1,head,members:[{
      memberId:event.ownerId,publicJwk:publicJwk(event.ownerPublicJwk),
      role:"owner",active:true,joinedEpoch:1,
    }],usedInvites:[],
  };
  if(event.kind==="join")return {...state,sequence:event.sequence,head,
    members:[...state.members,{memberId:event.memberId,
      publicJwk:publicJwk(event.memberPublicJwk),
      agreementPublicJwk:publicJwk(event.agreementPublicJwk),
      role:"member",active:true,joinedEpoch:state.epoch}],
    usedInvites:[...state.usedInvites,event.inviteId]};
  return {...state,sequence:event.sequence,head,epoch:event.epoch,
    members:state.members.map(m=>m.memberId===event.removedMemberId?{...m,active:false}:m)};
}

/**
 * Preview a signed rotation against a specific already verified/matched
 * membership state, without persisting it. This gives the deterministic
 * head to which the owner must bind all ciphertext packages BEFORE commit.
 * The state must be rechecked under the transaction at publication time.
 */
export async function previewSignedRotation(state,event) {
  ok(obj(state),"membership ledger uninitialised");
  await checkRotation(event,state);
  return applied(state,event);
}

/** First genesis can only be trusted if its public key is pinned out of band. */
export async function bootstrapLedger(storage, event, trustedOwnerPublicJwk) {
  await checkGenesis(event,trustedOwnerPublicJwk);
  return storage.transaction(async tx=>{
    ok(!await tx.get(ROOT),"membership ledger already initialised");
    const state=await applied(null,event);
    await tx.put(eventKey(1),event);
    await tx.put(ROOT,state);
    return state;
  });
}

/**
 * Persist a signed owner-rotation event. A new epoch does NOT distribute its
 * key; encryption/key-envelope rotation remains a separate unresolved gate.
 */
export async function rotateLedger(storage,event) {
  return storage.transaction(async tx=>{
    const state=await tx.get(ROOT);
    ok(state,"membership ledger uninitialised");
    await checkRotation(event,state);
    const next=await applied(state,event);
    ok(!await tx.get(eventKey(next.sequence)),"membership event sequence already exists");
    await tx.put(eventKey(next.sequence),event);
    await tx.put(ROOT,next);
    return next;
  });
}

/**
 * These adapters back QR registry authOwner and in-transaction enrollment.
 * authOwner is a fast precheck only; the registry MUST recheck inside tx.
 * No server claim can change the owner identity or epoch without a signed
 * ledger transition. This does not defend against server withholding history.
 */
export function ledgerAuthorizers(storage) {
  const authOwner=async({tx,listId,ownerId,epoch,ownerPublicJwk})=>{
    // When called inside QR registry's write transaction, read the SAME
    // transactional snapshot. An external read reopens an issuance race.
    const state=await (tx || storage).get(ROOT);
    return !!state&&state.listId===listId&&state.ownerId===ownerId&&
      state.epoch===epoch&&sameKey(state.ownerPublicJwk,ownerPublicJwk);
  };
  const authorizeEnrollment=async({tx,listId,ownerId,epoch})=>{
    const state=await tx.get(ROOT);
    return !!state&&state.listId===listId&&state.ownerId===ownerId&&
      state.epoch===epoch&&state.members.some(m=>m.memberId===ownerId&&m.active&&m.role==="owner");
  };
  const registerMember=async({tx,listId,inviteId,memberId,memberPublicJwk,
    agreementPublicJwk,nonce,proof,serverRecord})=>{
    const state=await tx.get(ROOT);
    ok(state&&state.listId===listId,"membership ledger not initialised");
    const body=joinBody({listId,sequence:state.sequence+1,previous:state.head,
      ownerId:state.ownerId,epoch:state.epoch,inviteId,memberId,
      memberPublicJwk,agreementPublicJwk,nonce,proof,grant:serverRecord});
    await checkJoin(body,state);
    const next=await applied(state,body);
    ok(!await tx.get(eventKey(next.sequence)),"membership event sequence already exists");
    await tx.put(eventKey(next.sequence),body);
    await tx.put(ROOT,next);
    return next;
  };
  return {authOwner,authorizeEnrollment,registerMember};
}

/**
 * Verify the *entire* append-only chain against a caller-pinned owner key.
 * Authenticated history does not prove the server has served the newest head.
 */
export async function verifyMembershipHistory(events,trustedOwnerPublicJwk) {
  ok(Array.isArray(events)&&events.length>0&&events.length<=10000,"invalid membership history");
  await checkGenesis(events[0],trustedOwnerPublicJwk);
  let state=await applied(null,events[0]);
  for(const event of events.slice(1)){
    if(event.kind==="join")await checkJoin(event,state);
    else if(event.kind==="rotate")await checkRotation(event,state);
    else throw new TypeError("unsupported membership transition");
    state=await applied(state,event);
  }
  return state;
}

export async function readMembershipEvents(storage) {
  const state=await storage.get(ROOT);
  if(!state)return [];
  ok(Number.isSafeInteger(state.sequence)&&state.sequence>0&&
    state.sequence<=10000,"invalid stored membership history length");
  const events=[];
  for(let sequence=1;sequence<=state.sequence;sequence++){
    const event=await storage.get(eventKey(sequence));
    ok(event,"membership event missing");
    events.push(event);
  }
  return events;
}


/**
 * Select recipient agreement keys only from a locally VERIFIED membership
 * history, never an untrusted server-provided recipient list. The owner is
 * excluded: owner creates the new epoch secret locally.
 *
 * CAUTION: callers must first verifyMembershipHistory() with a pinned
 * genesis AND check a previously pinned/latest head for rollback attacks.
 * A stale but valid chain is not proof of current membership.
 */
export function verifiedRekeyRecipients(verifiedState, removedMemberId) {
  ok(obj(verifiedState) && validId(removedMemberId) &&
    Array.isArray(verifiedState.members), "invalid verified membership state");
  ok(verifiedState.members.some(m=>m.memberId===removedMemberId &&
    m.role==="member"&&!m.active),"removed member must be revoked");
  return verifiedState.members.filter(m=>m.active&&m.role==="member")
    .map(m=>{
      ok(m.agreementPublicJwk,"active member is missing authenticated ECDH binding");
      return {memberId:m.memberId,agreementPublicJwk:publicJwk(m.agreementPublicJwk)};
    });
}
