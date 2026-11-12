// Markdown, in and out (web/md.js), without a browser:
//
//   node --test test/md.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { toMarkdown, fromMarkdown, pastedItems } from "../web/md.js";

const list = {
  name: "Shopping list", color: "green",
  sections: [
    { name: "Essentials", color: "ess", items: [{ text: "2 milk", checked: false }, { text: "Eggs", checked: true }] },
    { name: "Look out for", color: "look", items: [{ text: "Ripe avocados", checked: false }] },
    { name: "Long term", color: "long", items: [] },
  ],
};

test("export writes a title, sections in order and checkboxes, with colours in comments", () => {
  assert.equal(toMarkdown([list]), [
    "# Shopping list <!-- green -->",
    "",
    "## Essentials <!-- ink -->",
    "- [ ] 2 milk",
    "- [x] Eggs",
    "",
    "## Look out for <!-- amber -->",
    "- [ ] Ripe avocados",
    "",
    "## Long term <!-- indigo -->",
    "",
  ].join("\n"));
  assert.match(toMarkdown([{ ...list, color: "" }]), /^# Shopping list\n/, "a white list has no colour to write");
});

test("what is exported reads back the same, several lists too", () => {
  const other = { name: "Hardware store", color: "", sections: [{ name: "Garden", color: "teal", items: [{ text: "Hose", checked: false }] }] };
  const { lists, skipped } = fromMarkdown(toMarkdown([list, other]));
  assert.equal(skipped, 0);
  assert.deepEqual(lists, [list, { ...other, color: null }]);
});

test("any Markdown checklist reads: other bullets, numbers, headings of any level, plain lines", () => {
  const { lists, skipped } = fromMarkdown([
    "---", "title: from a notes app", "---",
    "Some notes before anything",
    "### Fruit",
    "* [X] Apples",
    "+ Pears",
    "1. Plums",
    "> a quote",
    "",
    "#### Bakery ####",
    "Bread",
    "```", "code", "```",
  ].join("\r\n"));
  assert.equal(lists.length, 1);
  assert.equal(lists[0].name, null);
  assert.deepEqual(lists[0].sections.map(s => [s.name, s.items.map(i => i.text + (i.checked ? " ✓" : ""))]), [
    [null, ["Some notes before anything"]],
    ["Fruit", ["Apples ✓", "Pears", "Plums"]],
    ["Bakery", ["Bread"]],
  ]);
  assert.equal(skipped, 4, "the quote and the code block");
});

test("the first export's text files read too, what was bought before going back in the first section", () => {
  for (const [title, bought] of [["Shopping list, 12 November 2026", "Bought before"], ["Liste de courses, 1er décembre 2026", "Déjà achetés"]]) {
    const { lists } = fromMarkdown([title, "", "Essentials", "- [ ] 2 eggs", "", "Look out for", "- [ ] Ripe avocados", "", bought, "- [x] Milk", ""].join("\n"));
    assert.equal(lists.length, 1);
    assert.equal(lists[0].name, title.split(",")[0]);
    assert.deepEqual(lists[0].sections.map(s => s.name), ["Essentials", "Look out for"]);
    assert.deepEqual(lists[0].sections[0].items, [{ text: "2 eggs", checked: false }, { text: "Milk", checked: true }]);
  }
});

test("pasting several lines gives one item each; one line is just text", () => {
  assert.equal(pastedItems("Milk"), null);
  assert.equal(pastedItems("Milk\n\n"), null);
  assert.deepEqual(pastedItems("## Dairy\n- [ ] Milk\n- [x] Butter\n  • Cheese\n\nYoghurt\n"), [
    { text: "Milk", checked: false }, { text: "Butter", checked: true }, { text: "Cheese", checked: false }, { text: "Yoghurt", checked: false },
  ]);
});
