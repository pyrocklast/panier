import { DurableObject } from "cloudflare:workers";

// Panier v2 isolated Cloudflare Durable Object HTTP service.
// This file is NOT referenced by production wrangler.jsonc or worker/index.js.
// All mutation content remains encrypted. No bearer list tokens.
// Threat boundaries: genesis key pinning, key freshness, owner recovery,
// durable receipts and production abuse controls remain unimplemented.
import {bootstrapLedger,ledgerAuthorizers,readMembershipEvents} from "./membership-ledger.mjs";
import {QrInvitationRegistry} from "./qr-registry.mjs";
import {publishAtomicRotation,readCurrentKeyPackage,assertCurrentEpochAppend} from "./atomic-rotation.mjs";
import {authorizeV2Request,signedRequestPath} from "./api-auth.mjs";

const ID=/^[A-Za-z0-9_-]{8,64}$/;
const HEADERS={"Content-Type":"application/json; charset=utf-8",
  "Cache-Control":"no-store","Referrer-Policy":"no-referrer",
  "X-Content-Type-Options":"nosniff",
  "Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'"};
const reply=(status,value)=>new Response(JSON.stringify(value),{status,headers:HEADERS});
const exact=(o,keys)=>o&&typeof o==="object"&&!Array.isArray(o)&&
  Object.keys(o).sort().join(",")===keys.slice().sort().join(",");
const raw64=x=>{
  if(typeof x!=="string"||x.length<2||x.length>24576||!/^[A-Za-z0-9_-]+$/.test(x))
    throw new Error("invalid encrypted message");
  const raw=Uint8Array.from(atob(x.replace(/-/g,"+").replace(/_/g,"/")),v=>v.charCodeAt(0));
  let str="";for(let i=0;i<raw.length;i+=4096)str+=String.fromCharCode(...raw.subarray(i,i+4096));
  if(btoa(str).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")!==x)
    throw new Error("noncanonical signed message");
  return new TextDecoder("utf-8",{fatal:true}).decode(raw);
};
async function verifyMutationWire(sealed,member){
  if(!exact(sealed,["listId","id","ciphertext"])||!ID.test(sealed.listId)||
    !ID.test(sealed.id))throw Error("invalid sealed mutation");
  const decoded=raw64(sealed.ciphertext);
  const e=JSON.parse(decoded);
  if(!exact(e,["v","listId","id","epoch","actorId","nonce","data","sig"])||
    e.v!==1||e.listId!==sealed.listId||e.id!==sealed.id||
    e.actorId!==member.memberId||!Number.isSafeInteger(e.epoch)||e.epoch<1)
    throw Error("invalid signed mutation identity");
  const canonical=JSON.stringify({v:e.v,listId:e.listId,id:e.id,
    epoch:e.epoch,actorId:e.actorId,nonce:e.nonce,data:e.data,sig:e.sig});
  if(decoded!==canonical)throw Error("noncanonical mutation wire format");
  const payload={v:e.v,listId:e.listId,id:e.id,epoch:e.epoch,
    actorId:e.actorId,nonce:e.nonce,data:e.data};
  const sig=Uint8Array.from(atob(e.sig.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
  if(sig.length!==64)throw Error("invalid mutation signature length");
  const k=await crypto.subtle.importKey("jwk",{
    kty:"EC",crv:"P-256",x:member.publicJwk.x,y:member.publicJwk.y,
  },{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  if(!await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},k,sig,
    new TextEncoder().encode(JSON.stringify(payload))))
    throw Error("invalid mutation signature");
  return e;
}
function pathOf(request) {
  const p=new URL(request.url).pathname;
  const m=p.match(/^\/v2\/lists\/([A-Za-z0-9_-]{8,64})\/(bootstrap|invitations|redeem|rotate|key-package|mutations|pull|history)$/);
  return m?{listId:m[1],route:m[2],path:p}:null;
}
async function parse(req){
  if(req.method!=="POST")throw Error("method not allowed");
  const max=42000;
  if(Number(req.headers.get("Content-Length"))>max)throw Error("request too large");
  if(!req.body)throw Error("empty request");
  const reader=req.body.getReader();
  const chunks=[];let size=0;
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>max)throw Error("request too large");
      chunks.push(value);
    }
  }catch(error){
    await reader.cancel().catch(()=>{});
    throw error;
  }
  const bytes=new Uint8Array(size);let at=0;
  for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
  const data=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  const value=JSON.parse(data);
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("invalid JSON request");
  return value;
}
async function route(storage,request,listId,routeName,path){
  const input=await parse(request);
  const auth=async requiredRole=>{
    if(!exact(input,["auth","body"]))throw Error("missing signed request body");
    const a=await authorizeV2Request(storage,{
      auth:input.auth,body:input.body,method:"POST",path,
      requiredRole,
    });
    if(a.listId!==listId)throw Error("wrong authorized list");
    return a;
  };
  if(routeName==="bootstrap"){
    if(!exact(input,["event"])||input.event.listId!==listId)
      throw Error("invalid list genesis");
    const state=await bootstrapLedger(storage,input.event,input.event.ownerPublicJwk,
      {idempotent:true});
    return reply(201,{listId,head:state.head,epoch:state.epoch});
  }
  if(routeName==="redeem"){
    if(!exact(input,["body"])||input.body.listId!==listId)throw Error("invalid redemption request");
    const registry=new QrInvitationRegistry({storage,...ledgerAuthorizers(storage)});
    return reply(201,await registry.redeem(input.body));
  }
  if(routeName==="invitations"){
    await auth("owner");
    const registry=new QrInvitationRegistry({storage,...ledgerAuthorizers(storage)});
    if(input.body.listId!==listId)throw Error("wrong list");
    return reply(201,await registry.createInvitation(input.body));
  }
  if(routeName==="rotate"){
    await auth("owner");
    if(input.body?.event?.listId!==listId)throw Error("invalid rotation list");
    return reply(200,await publishAtomicRotation(storage,input.body));
  }
  if(routeName==="key-package"){
    const member=await auth();
    if(!exact(input.body,["listId"])||input.body.listId!==listId)
      throw Error("invalid key package request");
    return reply(200,await readCurrentKeyPackage(storage,{
      listId,memberId:member.memberId,
    }));
  }
  if(routeName==="history"){
    await auth();
    if(!exact(input.body,["listId"])||input.body.listId!==listId)
      throw Error("invalid history request");
    const events=await readMembershipEvents(storage);
    if(events.length>10000)throw Error("membership history too large");
    return reply(200,{events}); // recipient must verify owner-pinned genesis
  }
  if(routeName==="mutations"){
    const principal=await auth();
    const sealed=input.body;
    if(!sealed||sealed.listId!==listId)throw Error("invalid mutation request");
    const state=await storage.get("membership:state");
    const member=state.members.find(m=>m.memberId===principal.memberId&&m.active);
    if(!member)throw Error("revoked mutation actor");
    const e=await verifyMutationWire(sealed,member);
    if(e.epoch!==principal.epoch)throw Error("stale mutation epoch");
    const accepted=await storage.transaction(async tx=>{
      await assertCurrentEpochAppend(tx,{listId,memberId:principal.memberId,epoch:e.epoch});
      const existing=await tx.get("mutations:id:"+e.id);
      if(existing){
        if(existing.ciphertext!==sealed.ciphertext)throw Error("mutation ID collision");
        return {id:e.id,revision:existing.revision,duplicate:true};
      }
      const cursor=await tx.get("mutations:revision")||0;
      if(cursor>=10000)throw Error("mutation log quota reached");
      const revision=cursor+1;
      await tx.put("mutations:id:"+e.id,{id:e.id,revision,ciphertext:sealed.ciphertext});
      await tx.put("mutations:at:"+revision,{id:e.id,revision,ciphertext:sealed.ciphertext});
      await tx.put("mutations:revision",revision);
      return {id:e.id,revision,duplicate:false};
    });
    return reply(200,accepted);
  }
  if(routeName==="pull"){
    await auth();
    const b=input.body;
    if(!exact(b,["listId","since"])||b.listId!==listId||
      !Number.isSafeInteger(b.since)||b.since<0)throw Error("invalid pull cursor");
    const latest=await storage.get("mutations:revision")||0;
    if(b.since>latest)throw Error("future pull cursor");
    const changes=[];
    for(let i=b.since+1;i<=Math.min(latest,b.since+100);i++){
      const entry=await storage.get("mutations:at:"+i);
      if(!entry)throw Error("accepted mutation history missing");
      changes.push(entry);
    }
    return reply(200,{latest,changes});
  }
  throw Error("not found");
}
export class V2List extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.storage=ctx.storage;}
  async fetch(request){
    const match=pathOf(request);
    if(!match)return reply(404,{error:"not found"});
    try{return await route(this.storage,request,match.listId,match.route,match.path);}
    catch(error){
      // Do not return details of signed keys, raw bodies, or storage state.
      const message=String(error?.message||"rejected");
      const code=/already|replay|collision|stale|future|rotation|incomplete|revoked|unavailable/.test(message)?409:403;
      return reply(code,{error:message.slice(0,180)});
    }
  }
}
export default {
  async fetch(req,env) {
    if(new URL(req.url).pathname==="/health")return reply(200,{service:"panier-v2-isolated"});
    const match=pathOf(req);
    if(!match)return reply(404,{error:"not found"});
    if(req.method!=="POST")return reply(405,{error:"method not allowed"});
    return env.V2_LISTS.get(env.V2_LISTS.idFromName(match.listId)).fetch(req);
  },
};
