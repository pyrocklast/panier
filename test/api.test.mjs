// API tests that both servers must pass: the Go server and the Cloudflare Worker.
//
//   BASE=http://127.0.0.1:8080 SETUP=ABCD-EFGH-JKMN node --test test/
//
// With FULL=1, also fills a list until the server refuses (run the Worker with a
// small MAX_LOG_BYTES for that).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const BASE = process.env.BASE || "http://127.0.0.1:8080";
const SETUP = process.env.SETUP;
if (!SETUP) throw new Error("set SETUP to the server's setup code");

const b64u = buf => buf.toString("base64url");
const enc = s => Buffer.from(s).toString("base64");

async function newList() {
  const id = randomBytes(16).toString("hex");
  const token = b64u(randomBytes(32));
  const res = await fetch(BASE + "/api/lists", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Setup-Code": SETUP.toLowerCase() },
    body: JSON.stringify({ id, auth: token }),
  });
  assert.equal(res.status, 201, "create");
  return { id, token, url: BASE + "/api/lists/" + id };
}
const auth = token => ({ Authorization: "Bearer " + token });
const post = (l, changes, token = l.token) =>
  fetch(l.url + "/changes", { method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
const get = async (l, since) => {
  const res = await fetch(l.url + "/changes" + (since === undefined ? "" : "?since=" + since), { headers: auth(l.token) });
  return { status: res.status, body: res.ok ? await res.json() : null };
};

test("the app is served with a strict content security policy", async () => {
  const res = await fetch(BASE + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") || "", /script-src 'self'/);
  assert.match(await res.text(), /<title>Panier<\/title>/);
});

test("creating a list needs the setup code and valid ids", async () => {
  const body = JSON.stringify({ id: randomBytes(16).toString("hex"), auth: b64u(randomBytes(32)) });
  const create = (code, b = body) => fetch(BASE + "/api/lists", { method: "POST", headers: { "X-Setup-Code": code }, body: b });
  assert.equal((await create("WRONG-CODE")).status, 403);
  assert.equal((await create(SETUP, JSON.stringify({ id: "../x", auth: b64u(randomBytes(32)) }))).status, 400);
  assert.equal((await create(SETUP, JSON.stringify({ id: randomBytes(16).toString("hex"), auth: "short" }))).status, 400);
  assert.equal((await create(SETUP)).status, 201);
  assert.equal((await create(SETUP)).status, 409);
});

test("lists need their token", async () => {
  const l = await newList();
  assert.equal((await fetch(l.url + "/changes")).status, 401);
  assert.equal((await fetch(l.url + "/changes", { headers: auth(b64u(randomBytes(32))) })).status, 401);
  const unknown = BASE + "/api/lists/" + randomBytes(16).toString("hex") + "/changes";
  assert.equal((await fetch(unknown, { headers: auth(l.token) })).status, 404);
});

test("changes round-trip in order", async () => {
  const l = await newList();
  let res = await post(l, ["QUJD", "REVG"]);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { latest: 2 });
  const { body } = await get(l, 1);
  assert.deepEqual(body, { changes: [{ seq: 2, data: "REVG" }], latest: 2 });
  assert.deepEqual((await get(l)).body.changes.map(c => c.seq), [1, 2]);
  assert.deepEqual((await get(l, 50)).body, { changes: [], latest: 2 });
});

test("malformed cursors are refused", async () => {
  const l = await newList();
  for (const bad of ["abc", "-1", "1.5"]) assert.equal((await get(l, bad)).status, 400, "since=" + bad);
});

test("limits are enforced and refused requests store nothing", async () => {
  const l = await newList();
  assert.equal((await post(l, Array(201).fill("QUJD"))).status, 400, "too many changes");
  assert.equal((await post(l, ["A".repeat(16 * 1024 + 4)])).status, 400, "change too big");
  assert.equal((await post(l, Array(20).fill("A".repeat(16 * 1024)))).status, 400, "request too big");
  assert.equal((await post(l, ["not base64!"])).status, 400, "not base64");
  assert.equal((await post(l, ["bad\nline"])).status, 400, "newline");
  assert.equal((await post(l, [])).status, 400, "empty");
  assert.equal((await get(l)).body.latest, 0);
});

test("pages hold at most 1000 changes and cover everything", async () => {
  const l = await newList();
  for (let b = 0; b < 13; b++) {
    const batch = [];
    for (let i = b * 200; i < Math.min(2500, (b + 1) * 200); i++) batch.push(enc(String(i + 1)));
    assert.equal((await post(l, batch)).status, 200);
  }
  let since = 0, seen = 0;
  for (;;) {
    const { body } = await get(l, since);
    assert.equal(body.latest, 2500);
    if (!body.changes.length) break;
    assert.ok(body.changes.length <= 1000);
    for (const c of body.changes) {
      seen++;
      assert.equal(c.seq, seen);
      assert.equal(c.data, enc(String(seen)));
    }
    since = body.changes.at(-1).seq;
  }
  assert.equal(seen, 2500);
});

function openLive(l, protocols) {
  const ws = new WebSocket(l.url.replace(/^http/, "ws") + "/live", protocols);
  const messages = [];
  let waiting = null;
  ws.onmessage = e => {
    messages.push(e.data);
    if (waiting) waiting();
  };
  const next = () =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no message")), 3000);
      const check = () => {
        if (messages.length) {
          clearTimeout(t);
          waiting = null;
          resolve(messages.shift());
        }
      };
      waiting = check;
      check();
    });
  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("refused"));
  });
  return { ws, next, opened };
}

test("live updates announce new changes", async () => {
  const l = await newList();
  await post(l, ["QUJD"]);
  const live = openLive(l, ["panier", l.token]);
  await live.opened;
  assert.equal(live.ws.protocol, "panier");
  assert.equal(await live.next(), "1");
  await post(l, ["REVG", "R0hJ"]);
  assert.equal(await live.next(), "3");
  live.ws.send("ping");
  assert.equal(await live.next(), "pong");
  live.ws.close();
});

test("live updates need the token", async () => {
  const l = await newList();
  await assert.rejects(openLive(l, ["panier", b64u(randomBytes(32))]).opened);
  await assert.rejects(openLive(l, ["panier"]).opened);
});

test("a list vouches for a new one with its token, instead of the setup code", async () => {
  const l = await newList();
  const vouch = (token, by = l.id) => {
    const id = randomBytes(16).toString("hex"), auth = b64u(randomBytes(32));
    return fetch(BASE + "/api/lists", { method: "POST", headers: { ...auth_(token), "Content-Type": "application/json" }, body: JSON.stringify({ id, auth, by }) })
      .then(res => ({ status: res.status, list: { id, token: auth, url: BASE + "/api/lists/" + id } }));
  };
  const auth_ = token => (token ? auth(token) : {});
  assert.equal((await vouch(b64u(randomBytes(32)))).status, 403, "a wrong token can't vouch");
  assert.equal((await vouch(null)).status, 400, "nor can no token");
  assert.equal((await vouch(l.token, randomBytes(16).toString("hex"))).status, 403, "nor a list that doesn't exist");
  const made = await vouch(l.token);
  assert.equal(made.status, 201);
  assert.equal((await post(made.list, ["QUJD"])).status, 200, "the new list works");
  const again = await vouch(made.list.token, made.list.id);
  assert.equal(again.status, 201, "and can vouch in turn");
});

test("a closed list loses its changes and refuses everything", async () => {
  const l = await newList();
  await post(l, ["QUJD", "REVG"]);
  const live = openLive(l, ["panier", l.token]);
  await live.opened;
  assert.equal(await live.next(), "2");
  const close = token => fetch(l.url, { method: "DELETE", headers: auth(token) });
  assert.equal((await close(b64u(randomBytes(32)))).status, 401, "only with its token");
  assert.equal((await close(l.token)).status, 204);
  assert.equal(await live.next(), "closed", "phones listening are told");
  assert.equal((await get(l)).status, 410);
  assert.equal((await post(l, ["R0hJ"])).status, 410);
  assert.equal((await close(l.token)).status, 204, "closing again changes nothing");
  await assert.rejects(openLive(l, ["panier", l.token]).opened, "no more live updates");
  const res = await fetch(BASE + "/api/lists", {
    method: "POST", headers: { ...auth(l.token), "Content-Type": "application/json" },
    body: JSON.stringify({ id: randomBytes(16).toString("hex"), auth: b64u(randomBytes(32)), by: l.id }),
  });
  assert.equal(res.status, 403, "a closed list can't vouch");
  const create = await fetch(BASE + "/api/lists", { method: "POST", headers: { "X-Setup-Code": SETUP }, body: JSON.stringify({ id: l.id, auth: b64u(randomBytes(32)) }) });
  assert.equal(create.status, 409, "and its id stays taken");
});

test("a full list refuses more changes", { skip: !process.env.FULL }, async () => {
  const l = await newList();
  const big = Array(15).fill("A".repeat(16 * 1024));
  let status = 200, before = 0;
  for (let i = 0; i < 200 && status === 200; i++) {
    before = (await get(l)).body.latest;
    status = (await post(l, big)).status;
  }
  assert.equal(status, 507);
  assert.equal((await get(l)).body.latest, before, "the refused batch stored nothing");
});
