import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { EventBus } from './event-bus.js';
import type { LavaEvent } from './types.js';

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

export class WebSocketHub {
  #sockets = new Set<Socket>();
  constructor(private readonly events: EventBus) {
    events.subscribe((event) => this.broadcast(event));
  }
  upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, '\r\n'
    ].join('\r\n'));
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => this.#sockets.delete(socket));
    socket.on('data', (data: Buffer) => {
      // Cliente pode enviar close ou ping. O protocolo de comandos continua no REST.
      const opcode = (data[0] ?? 0) & 0x0f;
      if (opcode === 0x8) socket.end(Buffer.from([0x88, 0x00]));
      if (opcode === 0x9) socket.write(Buffer.from([0x8a, 0x00]));
    });
    if (head.length) socket.emit('data', head);
    for (const event of this.events.history()) socket.write(frame(JSON.stringify(event)));
  }
  broadcast(event: LavaEvent): void {
    const data = frame(JSON.stringify(event));
    for (const socket of this.#sockets) {
      if (socket.destroyed || !socket.writable || socket.writableLength > 1_000_000) {
        socket.destroy(); this.#sockets.delete(socket); continue;
      }
      socket.write(data);
    }
  }
  close(): void { for (const socket of this.#sockets) socket.destroy(); this.#sockets.clear(); }
}
