import { consumeMemberSignedRequest } from "./do-quotas.mjs";
// Isolated Panier v2 HTTP request authentication.
// DO NOT reuse the v1 bearer token. Every request carries a new signed
// nonce; server checks current list membership and consumes nonce durably.
// This authenticates the caller but does not establish freshness of a
// server-provided membership history.
const enc=new TextEncoder();
const ID=/^[A-Za-z0-9_-]{8,64}$/;
const b64=x=>{const u=x instanceof Uint8Array?x:new Uint8Array(x);let s="";for(let i=0;i<u.length;i+=4096)s+=String.fromCharCode(...u.subarray(i,i+4096));return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");};
function raw64(x,size){if(typeof x!=="string"||!(/^[A-Za-z0-9_-]+$/).test(x)||x.length>128)throw new Error("invalid signature encoding");const v=Uint8Array.from(atob(x.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));if(v.length!==size||b64(v)!==x)throw new Error("invalid signature encoding");return v;}
const valid=x=>typeof x==="string"&&ID.test(x);
const statement=({listId,memberId,method,path,nonce,issuedAt,bodyHash})=>JSON.stringify({
  v:1,purpose:"panier/v2/api/request/1",listId,memberId,method,path,nonce,issuedAt,bodyHash,
});
const hash=async body=>b64(await crypto.subtle.digest("SHA-256",enc.encode(JSON.stringify(body))));
const key=async jwk=>crypto.subtle.importKey("jwk",{
  kty:"EC",crv:"P-256",x:jwk.x,y:jwk.y,
},{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
export async function signV2Request({listId,memberId,method="POST",path,body,privateKey,now=Date.now()}) {
  if(!valid(listId)||!valid(memberId)||typeof path!=="string"||!path.startsWith("/v2/"))
    throw new Error("invalid signed request target");
  const nonce=b64(crypto.getRandomValues(new Uint8Array(16)));
  const auth={v:1,listId,memberId,method,path,nonce,issuedAt:now,bodyHash:await hash(body)};
  const signature=b64(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},privateKey,
    enc.encode(statement(auth))));
  return {...auth,signature};
}
export async function authorizeV2Request(storage,{auth,body,method,path,now=Date.now(),requiredRole}) {
  if(!auth||auth.v!==1||!valid(auth.listId)||!valid(auth.memberId)||
    auth.method!==method||auth.path!==path||
    !Number.isSafeInteger(auth.issuedAt)||Math.abs(now-auth.issuedAt)>120000)
    throw new Error("invalid or expired request authorization");
  const nonce=raw64(auth.nonce,16),sig=raw64(auth.signature,64);
  if(auth.bodyHash!==await hash(body))throw new Error("signed request body mismatch");
  return storage.transaction(async tx=>{
    const state=await tx.get("membership:state");
    if(!state||state.listId!==auth.listId)throw new Error("unknown list");
    const member=state.members.find(x=>x.memberId===auth.memberId&&x.active);
    if(!member||(requiredRole&&member.role!==requiredRole))
      throw new Error("member not authorized");
    if(!await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},
      await key(member.publicJwk),sig,enc.encode(statement(auth))))
      throw new Error("invalid member signature");
    await consumeMemberSignedRequest(tx,{memberId:auth.memberId,
      nonce:auth.nonce,issuedAt:auth.issuedAt,now});
    return {listId:auth.listId,memberId:auth.memberId,epoch:state.epoch,head:state.head};
  });
}
export function signedRequestPath(listId,route) {
  if(!valid(listId)||!(/^[a-z-]+$/).test(route))throw new Error("invalid route");
  return "/v2/lists/"+listId+"/"+route;
}
