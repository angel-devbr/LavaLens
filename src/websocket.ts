import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { EventBus } from './event-bus.js';
import type { LavaEvent } from './types.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

const CLOSE_FRAME = Buffer.from([0x88, 0x00]);
const PONG_EMPTY = Buffer.from([0x8a, 0x00]);

interface Client { socket: Socket; buffer: Buffer; alive: boolean; }

export class WebSocketHub {
  #clients = new Map<Socket, Client>();
  #heartbeat: NodeJS.Timeout;

  constructor(private readonly events: EventBus) {
    events.subscribe((event) => this.broadcast(event));
    // Ping periódico detecta conexões mortas (half-open) que nunca emitem 'close'.
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients.values()) {
        if (!client.alive) { this.drop(client.socket); continue; }
        client.alive = false;
        this.safeWrite(client.socket, Buffer.from([0x89, 0x00])); // ping
      }
    }, 30_000);
    this.#heartbeat.unref();
  }

  get size(): number { return this.#clients.size; }

  upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    if (typeof key !== 'string' || (version && version !== '13')) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    socket.setKeepAlive(true);
    socket.setTimeout(0);

    const client: Client = { socket, buffer: Buffer.alloc(0), alive: true };
    this.#clients.set(socket, client);

    socket.on('close', () => this.#clients.delete(socket));
    socket.on('error', () => this.drop(socket));
    socket.on('data', (chunk: Buffer) => this.onData(client, chunk));
    if (head?.length) this.onData(client, head);

    for (const event of this.events.history()) this.safeWrite(socket, frame(JSON.stringify(event)));
  }

  /** Parser mínimo de frames do cliente: trata máscara, tamanho estendido e fragmentação. */
  private onData(client: Client, chunk: Buffer): void {
    client.buffer = client.buffer.length ? Buffer.concat([client.buffer, chunk]) : chunk;
    // Limite defensivo: cliente não pode nos fazer bufferizar memória infinita.
    if (client.buffer.length > 1_000_000) { this.drop(client.socket); return; }

    while (client.buffer.length >= 2) {
      const first = client.buffer[0]!;
      const second = client.buffer[1]!;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (client.buffer.length < 4) return;
        length = client.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (client.buffer.length < 10) return;
        const big = client.buffer.readBigUInt64BE(2);
        if (big > 1_000_000n) { this.drop(client.socket); return; }
        length = Number(big); offset = 10;
      }
      if (masked) offset += 4;
      if (client.buffer.length < offset + length) return;

      client.buffer = client.buffer.subarray(offset + length);

      if (opcode === 0x8) { this.safeWrite(client.socket, CLOSE_FRAME); this.drop(client.socket); return; }
      if (opcode === 0x9) this.safeWrite(client.socket, PONG_EMPTY);
      if (opcode === 0xa) client.alive = true;
    }
  }

  private safeWrite(socket: Socket, data: Buffer): void {
    if (socket.destroyed || !socket.writable) { this.drop(socket); return; }
    socket.write(data, (error) => { if (error) this.drop(socket); });
  }

  private drop(socket: Socket): void {
    this.#clients.delete(socket);
    if (!socket.destroyed) socket.destroy();
  }

  broadcast(event: LavaEvent): void {
    if (!this.#clients.size) return;
    const data = frame(JSON.stringify(event));
    for (const client of [...this.#clients.values()]) {
      const socket = client.socket;
      if (socket.destroyed || !socket.writable || socket.writableLength > 4_000_000) { this.drop(socket); continue; }
      this.safeWrite(socket, data);
    }
  }

  close(): void {
    clearInterval(this.#heartbeat);
    for (const client of [...this.#clients.values()]) {
      this.safeWrite(client.socket, CLOSE_FRAME);
      client.socket.destroy();
    }
    this.#clients.clear();
  }
}
