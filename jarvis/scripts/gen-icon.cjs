/**
 * Generates a placeholder arc-reactor-style tray/app icon (electron/icon.png)
 * with zero external dependencies — plain PNG encoding via Node's zlib + a
 * hand-rolled CRC32. Replace electron/icon.png with real artwork any time.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const CENTER = SIZE / 2;
const CORE_RADIUS = SIZE * 0.28;
const RING_RADIUS = SIZE * 0.4;
const OUTER_RADIUS = SIZE * 0.48;

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let offset = 0;
for (let y = 0; y < SIZE; y++) {
  raw[offset++] = 0; // no per-row filter
  for (let x = 0; x < SIZE; x++) {
    const dx = x - CENTER;
    const dy = y - CENTER;
    const dist = Math.sqrt(dx * dx + dy * dy);

    let r, g, b, a;
    if (dist < CORE_RADIUS) {
      r = 20; g = 235; b = 255; a = 255; // glowing cyan core
    } else if (dist < RING_RADIUS) {
      r = 5; g = 20; b = 30; a = 255; // dark gap
    } else if (dist < OUTER_RADIUS) {
      r = 0; g = 180; b = 220; a = 255; // outer ring
    } else {
      r = 0; g = 0; b = 0; a = 0; // transparent
    }

    raw[offset++] = r;
    raw[offset++] = g;
    raw[offset++] = b;
    raw[offset++] = a;
  }
}

const idatData = zlib.deflateSync(raw, { level: 9 });

const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  signature,
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', idatData),
  pngChunk('IEND', Buffer.alloc(0))
]);

const outPath = path.join(__dirname, '..', 'electron', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(`Icon written to ${outPath} (${png.length} bytes)`);
