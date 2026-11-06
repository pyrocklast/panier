import {test} from "node:test";
import assert from "node:assert/strict";
import {consumeMemberSignedRequest,consumePublicAttempt,
  MEMBER_PER_MINUTE,LIST_PER_MINUTE,PUBLIC_PER_MINUTE} from "../v2/do-quotas.mjs";

const NOW=1_750_000_000_000;
const MEMBER="memberAA01";
function database(){
  let current=new Map(),gate=Promise.resolve();
  return {
    transaction(callback){
      const run=async()=>{
        const staged=new Map([...current].map(([k,v])=>[k,structuredClone(v)]));
        const tx={get:async key=>staged.get(key),
          put:async(key,value)=>{staged.set(key,structuredClone(value));}};
        const result=await callback(tx);current=staged;return result;
      };
      const result=gate.then(run,run);
      gate=result.then(()=>{},()=>{});
      return result;
    },
    entries:()=>[...current],
  };
}
const nonce=n=>Buffer.alloc(16,n).toString("base64url");
const submit=(db,n,now=NOW,issuedAt=now)=>
  db.transaction(tx=>consumeMemberSignedRequest(tx,{
    memberId:MEMBER,nonce:nonce(n),now,issuedAt,
  }));

test("valid signed request records bounded nonce and rejects exact replay",async()=>{
  const db=database();
  await submit(db,1);
  await assert.rejects(submit(db,1),/replayed/);
  await submit(db,2);
  assert.equal(db.entries().filter(([key])=>key.startsWith("v2:nonce:")).length,1);
});

test("per-member requests are capped inside storage transaction",async()=>{
  const db=database();
  for(let i=0;i<MEMBER_PER_MINUTE;i++)
    await submit(db,i);
  await assert.rejects(submit(db,99),/rate limit/);
  assert.equal(db.entries().filter(([key])=>key.startsWith("v2:nonce:")).length,1);
});

test("rotating slots do not grow forever and reject replays while valid",async()=>{
  const db=database();
  for(let i=0;i<100;i++){
    const at=NOW+i*60000;
    await submit(db,i%256,at,at);
    if(i===1){
      await assert.rejects(submit(db,0,NOW+60000,NOW),/replayed/);
    }
  }
  const keys=db.entries().map(([key])=>key);
  assert.ok(keys.filter(key=>key.startsWith("v2:nonce:")).length<=6);
  assert.ok(keys.filter(key=>key.startsWith("v2:quota:")).length<=12);
});

test("signed request timestamps outside two-minute acceptance window fail closed",async()=>{
  const db=database();
  await assert.rejects(submit(db,1,NOW,NOW-120001),/expired/);
  await assert.rejects(submit(db,1,NOW,NOW+120001),/expired/);
  assert.equal(db.entries().length,0);
});

test("public anonymous QR and bootstrap attempts are bounded independently",async()=>{
  const db=database();
  for(let i=0;i<PUBLIC_PER_MINUTE;i++)
    await consumePublicAttempt(db,{kind:"redeem",now:NOW});
  await assert.rejects(consumePublicAttempt(db,{kind:"redeem",now:NOW}),
    /rate limit/);
  await consumePublicAttempt(db,{kind:"bootstrap",now:NOW});
  await consumePublicAttempt(db,{kind:"redeem",now:NOW+60000});
  assert.ok(db.entries().filter(([key])=>key.includes("public:")).length<=3);
});

test("concurrent public claims cannot evade per-list transaction budget",async()=>{
  const db=database();
  const all=await Promise.allSettled(Array.from({length:PUBLIC_PER_MINUTE+15},
    ()=>consumePublicAttempt(db,{kind:"redeem",now:NOW})));
  assert.equal(all.filter(v=>v.status==="fulfilled").length,PUBLIC_PER_MINUTE);
  assert.equal(all.filter(v=>v.status==="rejected").length,15);
});

test("fixed limits remain explicit for independent review",()=>{
  assert.equal(MEMBER_PER_MINUTE,60);
  assert.equal(LIST_PER_MINUTE,600);
  assert.equal(PUBLIC_PER_MINUTE,30);
});
