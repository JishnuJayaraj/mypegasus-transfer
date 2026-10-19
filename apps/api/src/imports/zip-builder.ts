import { crc32, deflateRawSync } from "node:zlib";

// Test helper: a ZIP archive written by hand, so a test can make a zip bomb or lie about sizes
// in the central directory (the bomb is generated in the test, never committed; plan 5.14).

export type TestZipEntry = {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  /** What the central directory claims, if not the truth. */
  declaredSize?: number;
  declaredCompressedSize?: number;
  flags?: number;
};

export function buildZip(entries: TestZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const raw = Buffer.from(entry.data);
    const stored = method === 8 ? deflateRawSync(raw, { level: 9 }) : raw;
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(entry.declaredCompressedSize ?? stored.length, 20);
    central.writeUInt32LE(entry.declaredSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directoryBytes, end]);
}
