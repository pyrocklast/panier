// Lists from Google Keep, as Google Takeout exports them: a .zip with a .json file for
// each note, or those .json files on their own. Each checklist outside the bin becomes a
// list as fromMarkdown gives them (see md.js): the note's title and colour, and its items
// in one section without a name, ticked as they were. Text notes stay behind.
//
// The files come from outside, so they're read with care: only what the zip's directory
// points to, at most a megabyte from each note, inflated by the browser itself.

const NOTE = 1 << 20; // a long note is a few kilobytes
// Keep's colours, each as the nearest paper.
const COLOURS = { RED: "rose", PINK: "rose", ORANGE: "look", YELLOW: "look", GREEN: "green", TEAL: "teal", BLUE: "blue", CERULEAN: "long", PURPLE: "plum", BROWN: "olive" };

// noteOf reads one note: a list, or null for anything but a checklist outside the bin.
// The list also says whether the note was archived, and when it was last edited.
export function noteOf(text) {
  let n;
  try { n = JSON.parse(text); } catch (_) { return null; }
  if (!n || !Array.isArray(n.listContent) || n.isTrashed === true) return null;
  const items = n.listContent.filter(i => i && typeof i.text === "string" && i.text.trim()).map(i => ({ text: i.text, checked: i.isChecked === true }));
  if (!items.length) return null;
  return {
    name: typeof n.title === "string" && n.title.trim() ? n.title.trim() : null,
    color: Object.hasOwn(COLOURS, n.color) ? COLOURS[n.color] : null,
    sections: [{ name: null, color: null, items }],
    archived: n.isArchived === true,
    edited: Number(n.userEditedTimestampUsec) || 0,
  };
}

// readKeep reads the files chosen, a Takeout .zip or the .json files in it, and gives the
// checklists among them, last edited first.
export async function readKeep(files) {
  const lists = [];
  const add = text => { const l = noteOf(text); if (l) lists.push(l); };
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) for await (const text of jsonIn(f)) add(text);
    else if (f.size <= NOTE) add(await f.text());
  }
  return lists.sort((a, b) => b.edited - a.edited);
}

// The .json files in a zip, each as text. A zip ends with a directory of what it holds,
// found by its signature near the end; each entry there says how it's packed (stored or
// deflated), how big it is, and where its own header starts, after which its data
// follows. Archives past 4 GB, or written as if they might be, keep the big numbers in
// Zip64 records.
async function* jsonIn(file) {
  const u16 = (v, at) => v.getUint16(at, true), u32 = (v, at) => v.getUint32(at, true), u64 = (v, at) => Number(v.getBigUint64(at, true));
  const bytes = async (from, to) => new DataView(await file.slice(from, to).arrayBuffer());
  const tail = await bytes(Math.max(0, file.size - 65557), file.size); // the end record, and the longest comment after it
  let e = tail.byteLength - 22;
  while (e >= 0 && u32(tail, e) !== 0x06054b50) e--;
  if (e < 0) return; // not a zip
  let size = u32(tail, e + 12), start = u32(tail, e + 16);
  if (e >= 20 && u32(tail, e - 20) === 0x07064b50) {
    const z = await bytes(u64(tail, e - 12), u64(tail, e - 12) + 56);
    if (u32(z, 0) !== 0x06064b50) return;
    size = u64(z, 40);
    start = u64(z, 48);
  }
  if (size > 1 << 26) return; // a directory that size isn't Keep's
  const dir = await bytes(start, start + size);
  for (let p = 0; p + 46 <= dir.byteLength && u32(dir, p) === 0x02014b50;) {
    const flags = u16(dir, p + 8), method = u16(dir, p + 10), nameLen = u16(dir, p + 28), extraLen = u16(dir, p + 30);
    let packed = u32(dir, p + 20), full = u32(dir, p + 24), at = u32(dir, p + 42);
    const name = new TextDecoder().decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen));
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end; x += 4 + u16(dir, x + 2)) {
      if (u16(dir, x) !== 1) continue; // Zip64's sizes and place, each there only when needed
      let y = x + 4;
      if (full === 0xffffffff) { full = u64(dir, y); y += 8; }
      if (packed === 0xffffffff) { packed = u64(dir, y); y += 8; }
      if (at === 0xffffffff) at = u64(dir, y);
    }
    p += 46 + nameLen + extraLen + u16(dir, p + 32);
    if (!/\.json$/i.test(name) || flags & 1 || (method !== 0 && method !== 8) || full > NOTE) continue; // encrypted, or packed some other way
    const head = await bytes(at, at + 30);
    if (u32(head, 0) !== 0x04034b50) continue;
    const from = at + 30 + u16(head, 26) + u16(head, 28);
    const text = await unpack(file.slice(from, from + packed), method);
    if (text !== null) yield text;
  }
}

// One entry's data as text: null if it's broken, or grows past a note's size whatever
// the directory said, as a zip made to overwhelm would.
async function unpack(blob, method) {
  const reader = (method === 8 ? blob.stream().pipeThrough(new DecompressionStream("deflate-raw")) : blob.stream()).getReader();
  const parts = [];
  let n = 0;
  try {
    for (let r; !(r = await reader.read()).done;) {
      if ((n += r.value.byteLength) > NOTE) { reader.cancel().catch(() => {}); return null; }
      parts.push(r.value);
    }
  } catch (_) {
    return null;
  }
  return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
}
