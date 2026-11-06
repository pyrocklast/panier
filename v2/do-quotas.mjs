// Bounded, list-scoped abuse controls for the isolated v2 Durable Object.
// The six fixed storage slots avoid permanently accumulating request nonces.
// Local DO transactions must guard all reads/writes to a slot together.
// This is NOT network-wide IP protection or a substitute for Cloudflare WAF.
const WINDOW_MS=60_000;
const SLOTS=6;
export const MEMBER_PER_MINUTE=60;
export const LIST_PER_MINUTE=600;
export const PUBLIC_PER_MINUTE=30;

const validMinute=n=>Number.isSafeInteger(n)&&n>=0;
const validId=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{8,64}$/.test(x);
const guard=(value,message)=>{if(!value)throw new Error(message);};
const bucket=(kind,slot)=>"v2:quota:"+kind+":"+slot;
const nonces=(memberId,slot)=>"v2:nonce:"+memberId+":"+slot;

function minuteAt(now){
  guard(Number.isSafeInteger(now)&&now>=0,"invalid quota clock");
  return Math.floor(now/WINDOW_MS);
}
async function limitOne(tx,kind,minute,max){
  const key=bucket(kind,minute%SLOTS);
  const old=await tx.get(key);
  const count=old&&old.minute===minute?old.count:0;
  guard(Number.isSafeInteger(count)&&count>=0&&count<max,
    "request rate limit exceeded");
  await tx.put(key,{minute,count:count+1});
}
export async function consumeMemberSignedRequest(tx,{memberId,nonce,issuedAt,now}){
  guard(tx&&typeof tx.get==="function"&&typeof tx.put==="function"&&
    validId(memberId)&&typeof nonce==="string"&&
    Number.isSafeInteger(issuedAt),"invalid signed request quota input");
  const signedMinute=minuteAt(issuedAt);
  const minute=minuteAt(now);
  // Signed requests must already have passed the +-120 second clock check.
  // A 6-minute ring exceeds the maximum lifetime of any valid signed
  // timestamp, so overwriting an old slot cannot revive a still-valid nonce.
  guard(Math.abs(now-issuedAt)<=120000,"expired signed request");
  const key=nonces(memberId,signedMinute%SLOTS);
  const row=await tx.get(key);
  const values=row?.minute===signedMinute?row.values:[];
  guard(Array.isArray(values)&&values.length<=MEMBER_PER_MINUTE,
    "invalid stored nonce quota");
  guard(!values.includes(nonce),"replayed signed request");
  guard(values.length<MEMBER_PER_MINUTE,"member request rate limit exceeded");
  await limitOne(tx,"member:"+memberId,minute,MEMBER_PER_MINUTE);
  await limitOne(tx,"list",minute,LIST_PER_MINUTE);
  await tx.put(key,{minute:signedMinute,values:[...values,nonce]});
}

/**
 * An unsigned QR claim must pay for a per-list budget BEFORE expensive
 * proof verification. This cannot prevent unlimited creation of new DOs
 * with random list IDs; require external WAF/edge limits before deployment.
 */
export async function consumePublicAttempt(storage,{kind,now=Date.now()}){
  guard(storage&&typeof storage.transaction==="function"&&
    (kind==="redeem"||kind==="bootstrap"),"invalid public attempt");
  const minute=minuteAt(now);
  return storage.transaction(tx=>limitOne(tx,"public:"+kind,minute,
    PUBLIC_PER_MINUTE));
}
