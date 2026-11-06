import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyList, applyOperation, replay, visibleItems, visibleSections, validateOperation } from "../v2/domain.mjs";

const LIST = "household01";
const A = "memberAA01";
const B = "memberBB02";
const C = "memberCC03";
const S = "section001";
const op = (revision, type, payload, suffix = "x") => ({ listId: LIST, revision, type, payload, id: "mutation_" + String(revision).padStart(3, "0") + suffix });
const add = (rev, id, name, position = "m", sectionId = null) => op(rev, "item.add", { id, name, position, sectionId });
const patch = (rev, id, fields) => op(rev, "item.patch", { id, fields });
const del = (rev, id) => op(rev, "item.delete", { id });
const section = (rev, id, name, position = "m") => op(rev, "section.add", { id, name, position });

test("two offline clients: independent additions, rename and check all survive in accepted order", () => {
  const history = [
    add(1, A, "Bread", "a"),
    add(2, B, "Milk", "b"),
    patch(3, A, { checked: true }),
    add(4, C, "Eggs", "c"),
    patch(5, A, { name: "Wholemeal bread" }),
  ];
  const first = replay(emptyList(LIST), history);
  const second = replay(replay(emptyList(LIST), history.slice(0, 2)), history.slice(2));
  assert.deepEqual(first, second);
  assert.equal(first.revision, 5);
  assert.deepEqual(visibleItems(first).map(i => [i.name, i.checked]), [
    ["Wholemeal bread", true], ["Milk", false], ["Eggs", false],
  ]);
});

test("distinct field edits combine; same-field edits use latest accepted revision", () => {
  const end = replay(emptyList(LIST), [
    add(1, A, "Bread"),
    patch(2, A, { checked: true }),
    patch(3, A, { name: "Rye bread" }),
    patch(4, A, { name: "Sourdough" }),
  ]);
  assert.equal(end.items[A].checked, true);
  assert.equal(end.items[A].name, "Sourdough");
});

test("delete creates a permanent tombstone including delete-before-add", () => {
  const end = replay(emptyList(LIST), [
    del(1, A), add(2, A, "A very late add"), patch(3, A, { checked: true }),
    add(4, B, "Milk"), del(5, B), patch(6, B, { name: "Resurrected" }),
  ]);
  assert.deepEqual(visibleItems(end), []);
  assert.equal(end.items[A].deleted, true);
  assert.equal(end.items[B].deleted, true);
  assert.equal(end.revision, 6);
});

test("section removal leaves items available as ungrouped; deterministic reorder ties", () => {
  const end = replay(emptyList(LIST), [
    section(1, S, "Essentials"),
    add(2, A, "Milk", "b", S),
    add(3, B, "Eggs", "a", S),
    patch(4, A, { position: "a" }),
    op(5, "section.delete", { id: S }),
  ]);
  assert.deepEqual(visibleItems(end).map(i => i.id), [A, B]);
  assert.ok(visibleItems(end).every(i => i.sectionId === null));
  assert.deepEqual(visibleSections(end), []);
});

test("replay of an accepted revision is idempotent; missing revision is refused", () => {
  const state = applyOperation(emptyList(LIST), add(1, A, "Milk"));
  assert.equal(applyOperation(state, add(1, A, "Milk")), state);
  assert.throws(() => applyOperation(state, add(3, B, "Eggs")), /missing prior revision/);
  assert.equal(state.revision, 1);
});

test("invalid and cross-list operations fail without mutating previous state", () => {
  const state = emptyList(LIST);
  assert.throws(() => applyOperation(state, { ...add(1, A, "Milk"), listId: "another001" }), /wrong list/);
  assert.throws(() => applyOperation(state, patch(1, A, { admin: true })), /unknown or invalid fields/);
  assert.throws(() => validateOperation(add(1, A, "  ")), /invalid field/);
  assert.throws(() => validateOperation(op(1, "unsupported.action", {})), /unsupported/);
  assert.equal(state.revision, 0);
  assert.deepEqual(visibleItems(state), []);
});

test("dangerous object-key-shaped IDs cannot affect object prototypes", () => {
  const state = replay(emptyList(LIST), [
    add(1, "__proto__", "Private"),
    add(2, "constructor", "Second"),
  ]);
  assert.deepEqual(visibleItems(state).map(i => i.name), ["Private", "Second"]);
  assert.equal(Object.getPrototypeOf(state.items), null);
  assert.equal(({}).name, undefined);
});

test("reducer does not mutate its prior state or other list instances", () => {
  const base = emptyList(LIST);
  const next = replay(base, [add(1, A, "Milk"), patch(2, A, { checked: true })]);
  assert.equal(base.revision, 0);
  assert.deepEqual(visibleItems(base), []);
  assert.notStrictEqual(base.items, next.items);
  assert.equal(visibleItems(emptyList("otherlist01")).length, 0);
});

test("accepted-log replay produces identical output after JSON checkpoint round-trip", () => {
  const first = replay(emptyList(LIST), [add(1, A, "Milk"), patch(2, A, { quantity: "2" })]);
  const restored = JSON.parse(JSON.stringify(first));
  const next = replay(first, [add(3, B, "Milk"), del(4, A)]);
  const again = replay(restored, [add(3, B, "Milk"), del(4, A)]);
  assert.deepEqual(next, again);
  assert.deepEqual(visibleItems(next).map(i => i.name), ["Milk"]);
});
