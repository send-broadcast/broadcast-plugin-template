// A minimal zip writer (deflate, no zip64) for .broadcast-plugin packages, and the server's path
// rules (app/services/plugins/package_reader.rb).
import { deflateRawSync } from "node:zlib";

export const ALLOWED_FILES = ["manifest.json", "dist/main.js", "README.md", "LICENSE"];
export const ALLOWED_FOLDERS = ["src/", "ui/", "assets/"];
const SAFE_SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9._@+-]*$/;

// null when the path may be in a package, else the reason.
export function packagePathError(path) {
  if (path.startsWith("/") || path.includes("\\")) return `${path}: not a relative path`;
  if (!path.split("/").every((segment) => SAFE_SEGMENT.test(segment))) {
    return `${path}: not an allowed file name (letters, digits and . _ @ + -; no leading dot; no ..)`;
  }
  if (!ALLOWED_FILES.includes(path) && !ALLOWED_FOLDERS.some((folder) => path.startsWith(folder))) {
    return `${path}: not in an allowed place (${[...ALLOWED_FILES, ...ALLOWED_FOLDERS].join(", ")})`;
  }
  return null;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// entries: [{ path, data: Buffer }] -> the zip as a Buffer. Refuses paths the server refuses.
export function zipFiles(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // A fixed time (1980-01-01): the same files always give the same package bytes.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const { path, data } of entries) {
    const error = packagePathError(path);
    if (error) throw new Error(error);
    const name = Buffer.from(path, "utf8");
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
