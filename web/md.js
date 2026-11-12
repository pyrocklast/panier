// Lists as Markdown, in and out: what Export writes, and what import and pasting read.
//
//   # Shopping list <!-- green -->
//
//   ## Essentials <!-- ink -->
//   - [ ] 2 milk
//   - [x] Eggs
//
// "#" is a list's name, "##" each of its sections in order, "- [ ]" an item to get and
// "- [x]" one bought before, under its section, so unticking puts it back there.
// Colours ride in comments after the headings, which Markdown hides. A file can hold
// several lists, each under its own "#".
//
// Reading is lenient, so lists from elsewhere come in too: any heading below "#" is a
// section, any bullet or numbered line an item, and so is a plain line, unless items
// follow it, as section names did in the text files the first export wrote.

// Colours by name in files, by id in the app.
const COLOURS = { ess: "ink", green: "green", teal: "teal", blue: "blue", long: "indigo", plum: "plum", rose: "rose", look: "amber", olive: "olive" };
const BY_NAME = Object.fromEntries(Object.entries(COLOURS).map(([id, n]) => [n, id]));

const one = s => String(s || "").replace(/\s+/g, " ").trim();
const tag = c => (COLOURS[c] ? " <!-- " + COLOURS[c] + " -->" : "");

// lists: [{ name, color, sections: [{ name, color, items: [{ text, checked }] }] }]
export function toMarkdown(lists) {
  return lists.map(l => {
    const out = ["# " + one(l.name) + tag(l.color)];
    for (const s of l.sections) {
      out.push("", "## " + one(s.name) + tag(s.color));
      for (const i of s.items) out.push((i.checked ? "- [x] " : "- [ ] ") + one(i.text));
    }
    return out.join("\n");
  }).join("\n\n\n") + "\n";
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const COLOUR = /\s*<!--\s*([a-z]+)\s*-->\s*$/i;
const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/;
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/;
const NOISE = /^\s*(?:>|\||<!--|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/; // quotes, tables, comments, rules
const DATED = /,\s+\d{1,2}(?:er)?\s+\S+\s+\d{4}$/; // the first export's title: "Shopping list, 12 November 2026"
const BOUGHT = /^(?:bought before|déjà achetés)$/i; // and its last section

function named(s) {
  const m = COLOUR.exec(s);
  const color = m && BY_NAME[m[1].toLowerCase()];
  return { name: one(m ? s.slice(0, m.index) : s), color: color ?? null };
}
const itemOf = line => {
  let m = TASK.exec(line);
  if (m) return { text: one(m[2]), checked: m[1] !== " " };
  m = BULLET.exec(line);
  return m ? { text: one(m[1].replace(/^\[\s?\]\s+/, "")), checked: false } : null;
};

// fromMarkdown reads lists from a file: { lists, skipped }, skipped counting the lines it
// couldn't use. A list or section without a name has name null; one without a colour,
// color null; a list's sections in order, an item's text as written.
export function fromMarkdown(text) {
  const lines = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  let k = 0, skipped = 0, fence = false;
  if (lines[0] && lines[0].trim() === "---") { // front matter, as notes apps write it
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) k = end + 1;
  }
  const lists = [];
  let list = null, sec = null;
  const newList = (name, color) => { list = { name, color, sections: [] }; lists.push(list); sec = null; };
  const newSection = (name, color) => {
    if (!list) newList(null, null);
    sec = { name, color, items: [] };
    list.sections.push(sec);
  };
  const add = it => {
    if (!it || !it.text) return;
    if (!sec) newSection(null, null);
    sec.items.push(it);
  };
  const next = i => { for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return lines[j]; return null; };
  for (let i = k; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; skipped++; continue; }
    if (fence) { if (line.trim()) skipped++; continue; }
    if (!line.trim()) continue;
    const h = HEADING.exec(line);
    if (h) {
      const { name, color } = named(h[2]);
      if (h[1].length === 1) newList(name || null, color);
      else newSection(name || null, color);
      continue;
    }
    const it = itemOf(line);
    if (it) { add(it); continue; }
    if (NOISE.test(line)) { skipped++; continue; }
    const plain = one(line), after = next(i);
    if (!lists.length && DATED.test(plain) && !(after && itemOf(after))) { newList(plain.replace(DATED, ""), null); continue; }
    if (after && itemOf(after) && plain.length <= 60) { newSection(named(plain).name, named(plain).color); continue; }
    add({ text: plain, checked: false });
  }
  // The first export listed what was bought before in a section of its own: those items
  // go back into the first section, still ticked.
  for (const l of lists) {
    const bought = l.sections.filter(s => s.name && BOUGHT.test(s.name) && s.items.every(i => i.checked));
    if (!bought.length) continue;
    l.sections = l.sections.filter(s => !bought.includes(s));
    if (!l.sections.length) l.sections.push({ name: null, color: null, items: [] });
    for (const s of bought) l.sections[0].items.push(...s.items);
  }
  return { lists: lists.filter(l => l.name || l.sections.some(s => s.items.length || s.name)), skipped };
}

// pastedItems reads what was pasted into an Add item field: several lines become several
// items, each as Markdown would read it, headings left out. One line is just text.
export function pastedItems(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 2) return null;
  const out = [];
  for (const line of lines) {
    if (HEADING.test(line) || NOISE.test(line)) continue;
    const it = itemOf(line) || { text: one(line), checked: false };
    if (it.text) out.push(it);
  }
  return out;
}
