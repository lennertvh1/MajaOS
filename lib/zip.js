'use strict';
/* A zip archive written as it is read. Files are stored, not compressed, so a large folder can stream. */
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

function crcUpdate(crc, buf) {
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function crc32(buf) {
  return (crcUpdate(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

function dosStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  let year = d.getFullYear();
  if (year < 1980) year = 1980;
  if (year > 2107) year = 2107;
  const day = ((year - 1980) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, day };
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function localHeader(name, time, day) {
  const nb = Buffer.from(name);
  return Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x0808), u16(0), u16(time), u16(day),
    u32(0), u32(0), u32(0), u16(nb.length), u16(0), nb,
  ]);
}

function descriptor(crc, size) {
  return Buffer.concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]);
}

function centralHeader(name, time, day, crc, size, offset) {
  const nb = Buffer.from(name);
  return Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0x0808), u16(0), u16(time), u16(day),
    u32(crc), u32(size), u32(size), u16(nb.length), u16(0), u16(0), u16(0), u16(0), u32(0),
    u32(offset), nb,
  ]);
}

function endRecord(count, cdSize, cdOffset) {
  return Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(cdSize), u32(cdOffset), u16(0),
  ]);
}

function writeAll(writable, buf) {
  return new Promise((resolve, reject) => {
    writable.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

function pipeEntry(writable, stream) {
  return new Promise((resolve, reject) => {
    let crc = 0xffffffff;
    let size = 0;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      writable.off('drain', resume);
      writable.off('error', onWriteErr);
      if (err) { stream.destroy(); reject(err); } else resolve(value);
    };
    const resume = () => stream.resume();
    const onWriteErr = (err) => finish(err);
    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = crcUpdate(crc, buf);
      size += buf.length;
      if (size > 0xffffffff) { finish(Object.assign(new Error('too big'), { code: 'TOOBIG' })); return; }
      if (!writable.write(buf)) stream.pause();
    });
    writable.on('drain', resume);
    writable.on('error', onWriteErr);
    stream.on('end', () => finish(null, { crc: (crc ^ 0xffffffff) >>> 0, size }));
    stream.on('error', (err) => finish(err));
  });
}

/* entries: { name, dir, mtime, open() -> Readable }. Directories have no open(). */
async function writeZip(writable, entries) {
  const central = [];
  let offset = 0;
  for (const ent of entries) {
    const name = ent.dir ? (String(ent.name).endsWith('/') ? ent.name : ent.name + '/') : ent.name;
    const { time, day } = dosStamp(ent.mtime);
    const head = localHeader(name, time, day);
    await writeAll(writable, head);
    let crc = 0;
    let size = 0;
    if (!ent.dir && ent.open) ({ crc, size } = await pipeEntry(writable, ent.open()));
    const desc = descriptor(crc, size);
    await writeAll(writable, desc);
    central.push(centralHeader(name, time, day, crc, size, offset));
    offset += head.length + size + desc.length;
  }
  const cd = central.length ? Buffer.concat(central) : Buffer.alloc(0);
  await writeAll(writable, cd);
  await writeAll(writable, endRecord(entries.length, cd.length, offset));
}

module.exports = { writeZip, crc32 };
