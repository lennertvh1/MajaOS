'use strict';
/*
 * Minimale WebSocket-server (RFC 6455), net genoeg om noVNC met het VNC-scherm van een VM te verbinden.
 * De browser praat WebSocket, QEMU praat gewoon TCP: wij geven de bytes in beide richtingen door.
 */
const net = require('node:net');
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 16 * 1024 * 1024;

function acceptKey(key) { return crypto.createHash('sha1').update(key + GUID).digest('base64'); }

// Frame van de server naar de browser (nooit gemaskeerd).
function encodeFrame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}

// Leest frames uit een stroom bytes. Geeft { fin, opcode, payload } terug; berichten in stukken plakt hij samen.
class FrameReader {
  constructor() { this.buf = Buffer.alloc(0); this.parts = []; this.partOp = 0; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 127, off = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) break; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_FRAME) throw new Error('Frame te groot');
      const masked = (b1 & 128) !== 0;
      if (this.buf.length < off + (masked ? 4 : 0) + len) break;
      const mask = masked ? this.buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);
      const fin = (b0 & 128) !== 0, opcode = b0 & 15;
      if (opcode >= 8) { out.push({ opcode, payload }); continue; } // controle-frames komen nooit in stukken
      if (opcode !== 0) this.partOp = opcode;
      this.parts.push(payload);
      if (fin) { out.push({ opcode: this.partOp, payload: Buffer.concat(this.parts) }); this.parts = []; }
    }
    return out;
  }
}

// Handshake afronden en de WebSocket koppelen aan een TCP-poort op deze server.
function proxyToTcp(req, socket, head, port, host = '127.0.0.1') {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const proto = protos.includes('binary') ? 'binary' : null;
  const tcp = net.connect(port, host);
  let open = true, connected = false;
  const closeAll = () => { if (!open) return; open = false; tcp.destroy(); try { socket.end(encodeFrame(8, Buffer.alloc(0))); } catch { /* al dicht */ } };
  tcp.once('connect', () => {
    connected = true;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n' + (proto ? 'Sec-WebSocket-Protocol: ' + proto + '\r\n' : '') + '\r\n');
    socket.setNoDelay(true);
    const reader = new FrameReader();
    const onData = (chunk) => {
      let frames;
      try { frames = reader.push(chunk); } catch { closeAll(); return; }
      for (const f of frames) {
        if (f.opcode === 8) { closeAll(); return; }
        if (f.opcode === 9) socket.write(encodeFrame(10, f.payload)); // ping → pong
        else if (f.opcode === 1 || f.opcode === 2) tcp.write(f.payload);
      }
    };
    if (head && head.length) onData(head);
    socket.on('data', onData);
    tcp.on('data', (d) => { if (open) socket.write(encodeFrame(2, d)); });
  });
  tcp.on('error', () => {
    if (connected) { closeAll(); return; }
    if (open) { open = false; socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }
  });
  tcp.on('close', () => { if (connected) closeAll(); });
  // Het HTTP-socket staat half open: sluit de browser, dan krijgen we alleen 'end'.
  socket.on('end', closeAll);
  socket.on('error', closeAll);
  socket.on('close', closeAll);
  tcp.on('end', () => { if (connected) closeAll(); });
}

module.exports = { proxyToTcp, encodeFrame, FrameReader, acceptKey };
