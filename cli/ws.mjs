// ws.mjs — a tiny, dependency-free WebSocket server side (RFC 6455) for the relay.
//
// agent-droid ships with zero npm dependencies, so instead of pulling in `ws`
// this implements the small subset the relay needs: the HTTP upgrade
// handshake, text/binary/ping/pong/close frames, client masking, 16/64-bit
// lengths, and fragmented messages. Server→client frames are never masked
// (per spec). Messages are delivered whole to `onMessage(string)`.

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 64 * 1024 * 1024; // screenshots arrive as base64 text; cap at 64 MB

export function acceptKey(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

// Encode one unmasked server frame.
export function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "", "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

// Incremental frame parser. Feed it socket chunks; it calls back with frames.
// Chunks are queued and only joined once a whole frame has arrived, so a
// multi-MB screenshot trickling in over 4G in 1.4 KB packets stays O(n).
export class FrameParser {
  constructor(onFrame) {
    this.chunks = [];
    this.queued = 0;
    this.need = 2; // bytes required before the next parse attempt is useful
    this.onFrame = onFrame;
  }
  push(chunk) {
    this.chunks.push(chunk);
    this.queued += chunk.length;
    while (this.queued >= this.need) {
      const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.queued);
      this.chunks = [buf];
      const used = this.parse(buf);
      if (used === 0) return; // this.need was raised; wait for more bytes
      const rest = buf.subarray(used);
      this.chunks = rest.length ? [rest] : [];
      this.queued = rest.length;
      this.need = 2;
    }
  }
  // Parse one frame from the head of buf; return bytes consumed (0 = incomplete).
  parse(buf) {
    if (buf.length < 2) {
      this.need = 2;
      return 0;
    }
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return ((this.need = 4), 0);
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return ((this.need = 10), 0);
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) throw new Error("frame too large");
      len = Number(big);
      off = 10;
    }
    const maskOff = off;
    if (masked) off += 4;
    if (buf.length < off + len) return ((this.need = off + len), 0);
    let payload;
    if (masked) {
      const m0 = buf[maskOff], m1 = buf[maskOff + 1], m2 = buf[maskOff + 2], m3 = buf[maskOff + 3];
      payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) {
        const k = i & 3;
        payload[i] = buf[off + i] ^ (k === 0 ? m0 : k === 1 ? m1 : k === 2 ? m2 : m3);
      }
    } else {
      payload = Buffer.from(buf.subarray(off, off + len));
    }
    this.onFrame({ fin, opcode, payload });
    return off + len;
  }
}

// Wrap an upgraded socket as a minimal WebSocket connection.
export class WsConn {
  constructor(socket, { onMessage, onClose } = {}, head) {
    this.socket = socket;
    this.open = true;
    this.lastSeen = Date.now();
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});
    let parts = [];
    let partsLen = 0;
    let partOpcode = 0;
    const parser = new FrameParser(({ fin, opcode, payload }) => {
      this.lastSeen = Date.now();
      if (opcode === 0x8) return this.close(1000); // close
      if (opcode === 0x9) return this.send(payload, 0xa); // ping → pong
      if (opcode === 0xa) return; // pong
      if (opcode === 0x1 || opcode === 0x2) {
        parts = [payload];
        partsLen = payload.length;
        partOpcode = opcode;
      } else if (opcode === 0x0) {
        parts.push(payload);
        partsLen += payload.length;
      } else return;
      if (partsLen > MAX_MESSAGE) return this.close(1009);
      if (fin) {
        const msg = Buffer.concat(parts, partsLen);
        parts = [];
        partsLen = 0;
        this.onMessage(partOpcode === 0x1 ? msg.toString("utf8") : msg);
      }
    });
    const feed = (chunk) => {
      try {
        parser.push(chunk);
      } catch (e) {
        if (process.env.DROID_WS_DEBUG) console.error("ws parse error", e);
        this.close(1002);
      }
    };
    socket.on("data", feed);
    // Bytes that arrived in the same packet as the HTTP upgrade.
    if (head && head.length) queueMicrotask(() => feed(head));
    const done = () => {
      if (!this.open) return;
      this.open = false;
      this.onClose();
    };
    socket.on("close", done);
    socket.on("error", done);
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 15000);
  }
  send(data, opcode = 0x1) {
    if (!this.open) return false;
    this.socket.write(encodeFrame(opcode, data));
    return true;
  }
  ping() {
    return this.send(Buffer.alloc(0), 0x9);
  }
  close(code = 1000) {
    if (this.open) {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code, 0);
      try {
        this.socket.write(encodeFrame(0x8, p));
      } catch {
        /* already gone */
      }
    }
    this.socket.end();
    this.socket.destroy();
    if (this.open) {
      this.open = false;
      this.onClose();
    }
  }
}

// Complete the HTTP upgrade. Returns a WsConn, or null after rejecting.
export function upgrade(req, socket, handlers, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return new WsConn(socket, handlers, head);
}
