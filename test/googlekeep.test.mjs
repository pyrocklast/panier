// Lists from Google Keep (web/googlekeep.js), without a browser:
//
//   node --test test/googlekeep.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { noteOf, readKeep } from "../web/googlekeep.js";
import { zip } from "./zip.mjs";

// Notes as Takeout writes them: one .json each, beside an .html copy and a few others.
const note = (title, items, more = {}) => JSON.stringify({
  color: "DEFAULT", isTrashed: false, isPinned: false, isArchived: false, title,
  listContent: items.map(([text, isChecked]) => ({ textHtml: "<p>" + text + "</p>", text, isChecked })),
  userEditedTimestampUsec: 1700000000000000, createdTimestampUsec: 1690000000000000, ...more,
});
const groceries = note("Groceries", [["Milk", false], ["Eggs", true], ["", false], ["2 lemons", false]], { color: "GREEN", userEditedTimestampUsec: 1760000000000000 });
const hardware = note("", [["Hose", false]], { isArchived: true, color: "CERULEAN" });
const takeout = [
  { name: "Takeout/Keep/Groceries.json", data: groceries },
  { name: "Takeout/Keep/Groceries.html", data: "<html></html>" },
  { name: "Takeout/Keep/2023-04-01T10_00_00.000+02_00.json", data: hardware, stored: true },
  { name: "Takeout/Keep/Idea.json", data: JSON.stringify({ title: "Idea", textContent: "A note, not a list", isTrashed: false }) },
  { name: "Takeout/Keep/Old.json", data: note("Old", [["Bread", false]], { isTrashed: true }) },
  { name: "Takeout/Keep/Labels.txt", data: "Shopping\n" },
  { name: "Takeout/archive_browser.html", data: "<html></html>" },
];
const file = (name, data) => new File([data], name);

test("a note becomes a list: its title, colour and items, ticked as they were", () => {
  assert.deepEqual(noteOf(groceries), {
    name: "Groceries", color: "green", archived: false, edited: 1760000000000000,
    sections: [{ name: null, color: null, items: [{ text: "Milk", checked: false }, { text: "Eggs", checked: true }, { text: "2 lemons", checked: false }] }],
  });
  assert.equal(noteOf(hardware).name, null, "no title, no name");
  assert.equal(noteOf(hardware).color, "long", "Keep's dark blue is indigo");
  assert.equal(noteOf(hardware).archived, true);
  assert.equal(noteOf(note("x", [["a", false]], { color: "GRAY" })).color, null, "grey is plain paper");
  assert.equal(noteOf(note("x", [["a", false]], { color: "constructor" })).color, null);
});

test("text notes, notes in the bin, empty lists and anything else stay behind", () => {
  assert.equal(noteOf(JSON.stringify({ title: "Idea", textContent: "Words" })), null);
  assert.equal(noteOf(note("Old", [["Bread", false]], { isTrashed: true })), null);
  assert.equal(noteOf(note("Empty", [["  ", false]])), null);
  for (const junk of ["", "not json", "null", "[]", '{"listContent":"no"}', '{"listContent":[null,1,{"text":3}]}']) assert.equal(noteOf(junk), null, junk);
});

test("a Takeout zip gives its checklists, last edited first", async () => {
  const lists = await readKeep([file("takeout-20261120T101010Z-001.zip", zip(takeout))]);
  assert.deepEqual(lists.map(l => [l.name, l.archived]), [["Groceries", false], [null, true]]);
  assert.deepEqual(lists[1].sections[0].items, [{ text: "Hose", checked: false }], "stored as well as deflated");
});

test("so does a zip written with Zip64, and the .json files on their own", async () => {
  const lists = await readKeep([file("takeout.zip", zip(takeout, { zip64: true }))]);
  assert.deepEqual(lists.map(l => l.name), ["Groceries", null]);
  const loose = await readKeep([file("Groceries.json", groceries), file("Hose.json", hardware), file("Idea.json", "{}")]);
  assert.deepEqual(loose.map(l => l.name), ["Groceries", null]);
});

test("a zip that isn't one, is cut short, or swells past a note's size gives what it can", async () => {
  assert.deepEqual(await readKeep([file("notes.zip", "not a zip at all")]), []);
  assert.deepEqual(await readKeep([file("empty.zip", "")]), []);
  assert.deepEqual(await readKeep([file("cut.zip", zip(takeout).subarray(0, 300))]), [], "its directory, at the end, is missing");
  const bomb = { name: "Takeout/Keep/Big.json", data: '{"listContent":[' + " ".repeat(3 << 20) + "]}", size: 100 }; // says 100 bytes, inflates to 3 MB
  const lists = await readKeep([file("takeout.zip", zip([bomb, takeout[0]]))]);
  assert.deepEqual(lists.map(l => l.name), ["Groceries"], "the swollen note is left out, the rest comes in");
});
