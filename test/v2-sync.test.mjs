import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyList, replay } from "../v2/domain.mjs";
import { pullVerified, syncOnce, SyncFailure } from "../v2/sync.mjs";

const LIST = "household01";
const A = "itemAA001", B = "itemBB002";
const operation = (revision, id, itemId, name) => ({
  listId: LIST, revision, id, type: "item.add",
  payload: { id: itemId, name, position: "a" },
});
const first = operation(1, "mutation01", A, "Milk");
const second = operation(2, "mutation02", B, "Eggs");

function harness({ history = [], pending = [], failPush = false, onPull } = {}) {
  let accepted = emptyList(LIST);
  let local = accepted;
  let queue = [...pending];
  const sent = [];
  const storage = {
    async readLocalList(_, id) {
      assert.equal(id, LIST);
      return { accepted, local, pending: queue.slice() };
    },
    async acceptRemoteOperations(_, id, ops) {
      assert.equal(id, LIST);
      const updated = replay(accepted, ops);
      const ids = new Set(ops.map(op => op.id));
      const remaining = queue.filter(p => !ids.has(p.id));
      // Commit accepted, pending queue and projection together.
      accepted = updated;
      queue = remaining;
      local = replay(accepted, queue.map((op, i) => ({
        ...op, listId: LIST, revision: accepted.revision + i + 1,
      })));
    },
  };
  const transport = {
    async pull(id, since) {
      assert.equal(id, LIST);
      const page = onPull
        ? onPull(since)
        : { latest: history.length, changes: history.filter(op => op.revision > since) };
      // The test double always serializes server entries as opaque envelopes,
      // including custom pagination fixtures. This is not real encryption.
      return { ...page, changes: page.changes?.map(op => ({
        ...op, ciphertext: "opaque:encrypted",
      })) };
    },
    async push(id, envelope) {
      assert.equal(id, LIST);
      sent.push(envelope);
      if (failPush) throw new Error("offline");
      const op = pending.find(p => p.id === envelope.id);
      assert.ok(op, "only known pending operations can be sent");
      if (!history.some(item => item.id === envelope.id)) history.push({
        ...op, revision: history.length + 1,
      });
    },
  };
  // These are *test doubles only*, not a crypto implementation. Real adapters
  // MUST authenticate signatures, list/epoch binding and immutable revision IDs.
  const security = {
    async decodeAndVerify(_, opaque) {
      const { ciphertext, ...op } = opaque;
      assert.equal(ciphertext, "opaque:encrypted");
      return op;
    },
    async loadSealed(id, mutationId) {
      return { listId: id, id: mutationId, ciphertext: "opaque:already-durable:" + mutationId };
    },
  };
  return { storage, transport, security, sent, snapshot: () => ({ accepted, queue, local }) };
}
const runPull = h => pullVerified({ db: {}, listId: LIST, ...h });
const runSync = h => syncOnce({ db: {}, listId: LIST, ...h });

test("verified remote history is applied and does not duplicate on repeat", async () => {
  const h = harness({ history: [first, second] });
  assert.deepEqual(await runPull(h), { revision: 2, applied: 2, pages: 1 });
  assert.equal(h.snapshot().accepted.items[A].name, "Milk");
  assert.deepEqual(await runPull(h), { revision: 2, applied: 0, pages: 1 });
});

test("page-by-page catch-up refuses revision gaps rather than skipping history", async () => {
  const h = harness({ onPull: since => since === 0
    ? { latest: 2, changes: [first] }
    : { latest: 2, changes: [second] } });
  assert.deepEqual(await runPull(h), { revision: 2, applied: 2, pages: 2 });
  const broken = harness({ onPull: () => ({ latest: 2, changes: [second] }) });
  await assert.rejects(runPull(broken), error => error.code === "gap");
  assert.equal(broken.snapshot().accepted.revision, 0);
});

test("server claims a later revision but returns no operations: fail, preserve cursor", async () => {
  const h = harness({ onPull: () => ({ latest: 2, changes: [] }) });
  await assert.rejects(runPull(h), error => error.code === "gap");
  assert.equal(h.snapshot().accepted.revision, 0);
});

test("tampered or mismatched authenticated output fails closed", async () => {
  const h = harness({ history: [first] });
  h.security.decodeAndVerify = async () => ({ ...first, id: "substitute01" });
  await assert.rejects(runPull(h), error => error.code === "verification");
  assert.equal(h.snapshot().accepted.revision, 0);
  h.security.decodeAndVerify = async () => { throw new Error("bad signature"); };
  await assert.rejects(runPull(h), error => error.code === "verification");
});

test("upload is confirmed only by verified pull; retry after lost acknowledgement is idempotent", async () => {
  const pending = [{ ...first, revision: undefined }];
  const history = [];
  const h = harness({ history, pending });
  const firstPass = await runSync(h);
  assert.deepEqual(firstPass, { revision: 1, pending: 0, pushed: 1, pulled: 1, synced: true });
  assert.equal(h.sent.length, 1);
  const nextPass = await runSync(h);
  assert.equal(nextPass.pushed, 0);
  assert.equal(history.length, 1);
});

test("upload failure retains pending work and reports network failure", async () => {
  const pending = [{ ...first, revision: undefined }];
  const h = harness({ pending, failPush: true });
  await assert.rejects(runSync(h), error => error instanceof SyncFailure && error.code === "network");
  assert.equal(h.snapshot().queue.length, 1);
  assert.equal(h.snapshot().accepted.revision, 0);
});

test("a successful push with no visible server operation keeps the outbox pending", async () => {
  const pending = [{ ...first, revision: undefined }];
  const h = harness({ pending });
  h.transport.push = async () => {}; // HTTP success but server log not yet readable
  const result = await runSync(h);
  assert.equal(result.synced, false);
  assert.equal(result.pending, 1);
});

test("missing durable ciphertext stops upload instead of leaking plaintext", async () => {
  const pending = [{ ...first, revision: undefined }];
  const h = harness({ pending });
  h.security.loadSealed = async () => null;
  await assert.rejects(runSync(h), e => e.code === "seal");
  assert.deepEqual(h.sent, []);
  assert.equal(h.snapshot().queue.length, 1);
});

test("invalid remote pages, endless pages, and unsupported adapter fail explicitly", async () => {
  const malformed = harness({ onPull: () => ({ latest: -1, changes: [] }) });
  await assert.rejects(runPull(malformed), error => error.code === "protocol");
  const continuous = harness({ onPull: since => ({
    latest: 1000, changes: [operation(since + 1, "mutation" + (since + 1), "itemAA001", "Milk")],
  }) });
  await assert.rejects(pullVerified({ db: {}, listId: LIST, ...continuous, maxPages: 2 }),
    error => error.code === "limit");
  await assert.rejects(syncOnce({ db: {}, listId: LIST, storage: continuous.storage,
    transport: continuous.transport, security: { decodeAndVerify: () => first } }), TypeError);
});

test("independent remote additions and local pending edits remain in the projection", async () => {
  const pending = [{ ...second, revision: undefined }];
  const h = harness({ pending, history: [first] });
  await runPull(h);
  const snapshot = h.snapshot();
  assert.equal(snapshot.accepted.revision, 1);
  assert.equal(snapshot.queue.length, 1);
  assert.equal(snapshot.local.items[A].name, "Milk");
  assert.equal(snapshot.local.items[B].name, "Eggs");
});

test("sync retains verification and stale-epoch error codes from secure transport",async()=>{
  const pull=harness({pending:[{...first,revision:undefined}]});
  pull.transport.pull=async()=>{throw new SyncFailure("verification",
    "Pinned membership history was substituted");};
  await assert.rejects(runSync(pull),e=>e.code==="verification");
  assert.equal(pull.snapshot().accepted.revision,0);
  assert.equal(pull.snapshot().queue.length,1);
  const push=harness({pending:[{...first,revision:undefined}]});
  push.transport.push=async()=>{throw new SyncFailure("stale-epoch",
    "Cannot upload prior-epoch ciphertext");};
  await assert.rejects(runSync(push),e=>e.code==="stale-epoch");
  assert.equal(push.snapshot().queue.length,1);
  assert.equal(push.snapshot().accepted.revision,0);
});
