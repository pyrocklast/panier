// Panier v2: deliberately isolated browser sync behind an independently
// pinned owner root, monotonic membership checkpoints and signed HTTP calls.
// No production PWA uses this yet. It does NOT prove freshness against a
// server that withholds an unseen signed membership suffix.
import { syncOnce, pullVerified, SyncFailure } from "./sync.mjs";
import * as storage from "./storage.mjs";
import { createSyncSecurity, importMemberPublicKey } from "./crypto.mjs";
import { readPinnedTrust, advancePinnedMembership } from "./trust.mjs";
import { signV2Request, signedRequestPath } from "./api-auth.mjs";
import { sealedMutationEpoch } from "./rekey.mjs";

const ID=/^[A-Za-z0-9_-]{8,64}$/;
const MAX_REPLY=1024*1024;
const requireThat=(yes,message)=>{if(!yes)throw new TypeError(message);};
const validId=x=>typeof x==="string"&&ID.test(x);
const dataObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);

function historicalSigningKey(events,actorId,epoch) {
  // Only keys from a fully verified owner-pinned, signed membership history.
  // A member revoked in epoch N may have valid accepted operations under
  // earlier epoch N-1, but must not sign operations for N or later.
  const genesis=events[0];
  if(actorId===genesis.ownerId)return genesis.ownerPublicJwk;
  let key=null,joinedEpoch=Infinity,removedEpoch=Infinity;
  for(const event of events.slice(1)){
    if(event.kind==="join"&&event.memberId===actorId){
      if(key)return null;
      key=event.memberPublicJwk;joinedEpoch=event.epoch;
    }else if(event.kind==="rotate"&&event.removedMemberId===actorId){
      removedEpoch=Math.min(removedEpoch,event.epoch);
    }
  }
  return key&&joinedEpoch<=epoch&&epoch<removedEpoch?key:null;
}

/**
 * The server can validate membership *at upload time*, but its accepted log
 * does not cryptographically record which signed membership transition came
 * before each accepted revision. Historical authorization within the SAME
 * epoch as a join cannot be independently proven from these two logs yet.
 * This resolver verifies member KEY and epoch constraints, NOT append ordering.
 */
export function verifiedHistoricalMemberKey(events,actorId,epoch) {
  requireThat(Array.isArray(events)&&events.length>0&&validId(actorId)&&
    Number.isSafeInteger(epoch)&&epoch>=1,"invalid historical membership lookup");
  return historicalSigningKey(events,actorId,epoch);
}

function currentMember(state,memberId) {
  return state.members.find(m=>m.memberId===memberId&&m.active);
}
function apiOrigin(baseUrl){
  const url=new URL(baseUrl);
  const local=url.hostname==="127.0.0.1"||url.hostname==="localhost";
  requireThat((url.protocol==="https:"||local&&url.protocol==="http:")&&
    !url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==="/",
    "expected HTTPS API origin or loopback development origin");
  return url.origin;
}
async function boundedJson(response){
  const announced=Number(response.headers?.get?.("Content-Length"));
  requireThat(!Number.isFinite(announced)||announced<=MAX_REPLY,
    "oversized signed API response");
  const text=await response.text();
  requireThat(text.length<=MAX_REPLY,"oversized signed API response");
  const body=JSON.parse(text);
  requireThat(dataObject(body),"malformed signed API response");
  return body;
}

/**
 * Exposes only a narrow, trust-gated sync operation. It MUST be created from
 * an already pinned local owner genesis or owner-verified in-person QR root.
 * secretForEpoch(epoch) must resolve the correct locally retained list key.
 * It MUST NOT resolve keys from Cloudflare or the untrusted wire envelope.
 */
export function createTrustedSync({
  db,trustDb,listId,memberId,memberSigningPrivateKey,
  secretForEpoch,baseUrl,request=fetch,now=()=>Date.now(),
}) {
  requireThat(db&&trustDb&&validId(listId)&&validId(memberId)&&
    memberSigningPrivateKey instanceof CryptoKey&&
    memberSigningPrivateKey.type==="private"&&
    memberSigningPrivateKey.algorithm.name==="ECDSA"&&
    typeof secretForEpoch==="function"&&typeof request==="function"&&
    typeof now==="function","missing trusted sync credentials");
  const origin=apiOrigin(baseUrl);
  let verified=null;

  async function signedRoute(route,body){
    const path=signedRequestPath(listId,route);
    const auth=await signV2Request({listId,memberId,path,body,
      privateKey:memberSigningPrivateKey,now:now()});
    let response;
    try{
      response=await request(origin+path,{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({auth,body}),
        cache:"no-store",credentials:"omit",redirect:"error"});
    }catch(error){
      throw new SyncFailure("network","Unable to reach authenticated v2 API",error);
    }
    if(!response||typeof response.ok!=="boolean")
      throw new SyncFailure("protocol","Invalid authenticated API response");
    if(!response.ok){
      // No automatic retries of signed nonces; each new call signs a new nonce.
      throw new SyncFailure(response.status===403?"authorization":"network",
        "Authenticated API refused the request");
    }
    try{return await boundedJson(response);}
    catch(error){throw new SyncFailure("protocol","Malformed authenticated API reply",error);}
  }

  async function refreshMembership(){
    const pinned=await readPinnedTrust(trustDb,listId);
    if(!pinned)throw new SyncFailure("untrusted","List owner has not been pinned locally");
    // Never use the server's genesis/public key to create the trust anchor.
    const result=await signedRoute("history",{listId});
    if(!dataObject(result)||!Array.isArray(result.events))
      throw new SyncFailure("verification","Signed membership history is missing");
    let updated;
    try{updated=await advancePinnedMembership(trustDb,listId,result.events);}
    catch(error){
      throw new SyncFailure("verification","Membership history contradicts pinned trust",error);
    }
    const state=await import("./membership-ledger.mjs").then(
      ({verifyMembershipHistory})=>verifyMembershipHistory(result.events,updated.ownerPublicJwk));
    if(state.head!==updated.checkpoint.head||state.sequence!==updated.checkpoint.sequence)
      throw new SyncFailure("verification","Membership checkpoint changed during verification");
    verified={state,events:result.events,checkpoint:updated.checkpoint};
    return verified;
  }

  async function readyMember(){
    const membership=await refreshMembership();
    const member=currentMember(membership.state,memberId);
    if(!member)throw new SyncFailure("revoked","Device is not an active member");
    const expected=await importMemberPublicKey(member.publicJwk);
    // Prove that the provided signing key matches the authenticated member
    // public key; do not allow a mismatched credential to proceed even if
    // the later HTTP request would be refused.
    const challenge=new TextEncoder().encode("panier/v2/trusted-sync/device-key-check");
    const signature=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},
      memberSigningPrivateKey,challenge);
    if(!await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},expected,
      signature,challenge))
      throw new SyncFailure("authorization","Signing key does not match the verified member");
    return membership;
  }

  const transport={
    async pull(id,since){
      requireThat(id===listId,"wrong list");
      // Verify and advance membership BEFORE requesting an operation page.
      await readyMember();
      const page=await signedRoute("pull",{listId,since});
      // Also refresh AFTER fetching: catch an observed revocation/fork before
      // the coordinator accepts and durably commits decrypted operations.
      await readyMember();
      return page;
    },
    async push(id,sealed){
      requireThat(id===listId,"wrong list");
      const {state}=await readyMember();
      requireThat(dataObject(sealed)&&sealed.listId===listId&&validId(sealed.id),
        "invalid sealed outbox mutation");
      let epoch;
      try{epoch=sealedMutationEpoch(sealed);}
      catch(error){throw new SyncFailure("seal","Malformed durable pending envelope",error);}
      // Never send a stale or future epoch signed message. Keep the original
      // outbox intact for an explicit, independently reviewed rebase flow.
      if(epoch!==state.epoch)
        throw new SyncFailure("stale-epoch","Offline edit needs an explicit epoch rebase");
      const result=await signedRoute("mutations",sealed);
      if(result.id!==sealed.id||!Number.isSafeInteger(result.revision)||
        result.revision<1)throw new SyncFailure("protocol","Invalid accepted mutation receipt");
      return result; // not authoritative acknowledgement: verified pull is.
    },
  };
  const security=createSyncSecurity({
    db,loadSealedMutation:storage.loadSealedMutation,
    resolveMember:async({listId:id,actorId,epoch})=>{
      if(id!==listId||!verified)return null;
      const jwk=verifiedHistoricalMemberKey(verified.events,actorId,epoch);
      return jwk?importMemberPublicKey(jwk):null;
    },
    resolveListSecret:async({listId:id,epoch})=>{
      if(id!==listId||!verified)return null;
      return secretForEpoch(epoch);
    },
  });
  return {
    refreshMembership,
    pull:()=>pullVerified({db,listId,storage,transport,security}),
    sync:()=>syncOnce({db,listId,storage,transport,security}),
  };
}
