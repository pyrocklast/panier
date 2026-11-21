// A small zip writer for the tests, so they can make Google Takeout files: each entry
// deflated unless stored, and with zip64, written as an archive past 4 GB would be.

import { deflateRawSync } from "node:zlib";

const crc32 = buf => {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
};

// entries: [{ name, data (string or Buffer), stored, size (claimed, to lie about) }]
export function zip(entries, { zip64 = false } = {}) {
  const parts = [], dir = [];
  let at = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data), data = e.stored ? raw : deflateRawSync(raw), name = Buffer.from(e.name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(zip64 ? 45 : 20, 4);
    head.writeUInt16LE(0x800, 6); // names in UTF-8
    head.writeUInt16LE(e.stored ? 0 : 8, 8);
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(e.size ?? raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(e.size ?? raw.length), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
      extra.writeBigUInt64LE(BigInt(at), 20);
    }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(zip64 ? 45 : 20, 4);
    head.copy(cd, 6, 4, 28); // version needed through the name's length, as in the header
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt32LE(zip64 ? 0xffffffff : at, 42);
    if (zip64) { cd.writeUInt32LE(0xffffffff, 20); cd.writeUInt32LE(0xffffffff, 24); }
    dir.push(cd, name, extra);
    parts.push(head, name, data);
    at += head.length + name.length + data.length;
  }
  const cd = Buffer.concat(dir), count = entries.length, end = [];
  if (zip64) {
    const z = Buffer.alloc(56), loc = Buffer.alloc(20);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(cd.length), 40);
    z.writeBigUInt64LE(BigInt(at), 48);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(at + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    end.push(z, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : count, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : count, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : at, 16);
  return Buffer.concat([...parts, cd, ...end, eocd]);
}
