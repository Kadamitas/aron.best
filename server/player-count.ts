import { createConnection } from 'node:net';

export interface PlayerCount { online: number | null; max: number | null; names: string[] | null }

const unknown: PlayerCount = { online: null, max: null, names: null };
const maximumResponseBytes = 128 * 1024;

function integer(bytes: Buffer, offset = 0): { value: number; next: number } | undefined {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) return undefined;
    if (index === 4 && byte > 7) throw new Error('Invalid status length.');
    value += (byte & 127) * 2 ** (index * 7);
    if (!(byte & 128)) return { value, next: offset + index + 1 };
  }
  throw new Error('Invalid status length.');
}

function counts(online: unknown, max: unknown, sample?: unknown): PlayerCount {
  if (!Number.isSafeInteger(online) || !Number.isSafeInteger(max) || Number(online) < 0 || Number(max) < 0 || Number(online) > 1_000_000 || Number(max) > 1_000_000) throw new Error('Invalid player counts.');
  const names = Array.isArray(sample) ? [...new Set(sample.flatMap(value => typeof value?.name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(value.name) ? [value.name as string] : []))].slice(0, Number(online)) : online === 0 ? [] : null;
  return { online: online as number, max: max as number, names };
}

function modernReply(bytes: Buffer): PlayerCount | undefined {
  const frame = integer(bytes);
  if (!frame) return undefined;
  if (frame.value > maximumResponseBytes || frame.value < 2) throw new Error('Invalid status packet size.');
  if (bytes.length < frame.next + frame.value) return undefined;
  const packet = bytes.subarray(frame.next, frame.next + frame.value);
  const id = integer(packet);
  if (!id || id.value !== 0) throw new Error('Unexpected status packet.');
  const text = integer(packet, id.next);
  if (!text || text.value + text.next !== packet.length) throw new Error('Invalid status payload.');
  const payload = JSON.parse(packet.subarray(text.next).toString('utf8')) as { players?: { online?: unknown; max?: unknown; sample?: unknown } };
  return counts(payload.players?.online, payload.players?.max, payload.players?.sample);
}

function legacyReply(bytes: Buffer): PlayerCount | undefined {
  if (!bytes.length) return undefined;
  if (bytes[0] !== 255) throw new Error('Unexpected legacy status packet.');
  if (bytes.length < 3) return undefined;
  const length = bytes.readUInt16BE(1) * 2;
  if (length > maximumResponseBytes - 3) throw new Error('Legacy status packet is too large.');
  if (bytes.length < length + 3) return undefined;
  const values = Buffer.from(bytes.subarray(3, length + 3)).swap16().toString('utf16le').split('\0');
  if (values.length !== 6 || values[0] !== '§1' || !/^\d+$/.test(values[4]!) || !/^\d+$/.test(values[5]!)) throw new Error('Invalid legacy player counts.');
  return counts(Number(values[4]), Number(values[5]));
}

export function queryPlayerCount(version: string, signal: AbortSignal, port = 25566, timeoutMs = 2000): Promise<PlayerCount> {
  signal.throwIfAborted();
  const legacy = /^1\.[0-6](?:\.|$)/.test(version);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.unref();
    let response = Buffer.alloc(0);
    let finished = false;
    const finish = (error?: Error, result?: PlayerCount) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error('Player count request cancelled.'));
    const deadline = setTimeout(() => finish(new Error('Player count request timed out.')), timeoutMs);
    deadline.unref();
    signal.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => {
      if (legacy) { socket.write(Buffer.from([254, 1])); return; }
      const host = Buffer.from('127.0.0.1');
      const address = Buffer.alloc(2);
      address.writeUInt16BE(port);
      const handshake = Buffer.concat([Buffer.from([0, 255, 255, 255, 255, 15, host.length]), host, address, Buffer.from([1])]);
      socket.write(Buffer.concat([Buffer.from([handshake.length]), handshake, Buffer.from([1, 0])]));
    });
    socket.on('data', chunk => {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (response.length + bytes.length > maximumResponseBytes) throw new Error('Status response is too large.');
        response = Buffer.concat([response, bytes]);
        const result = legacy ? legacyReply(response) : modernReply(response);
        if (result) finish(undefined, result);
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid status response.')); }
    });
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('Status connection closed before its reply.')));
    socket.once('close', () => finish(new Error('Status connection closed before its reply.')));
    if (signal.aborted) abort();
  });
}

export class PlayerCountMonitor {
  private value: PlayerCount = { online: 0, max: null, names: [] };
  private currentVersion?: string;
  private lastAttempt = -Infinity;
  private pending?: AbortController;
  constructor(private readonly query = queryPlayerCount, private readonly now = Date.now) {}

  read(running: boolean, version: string): PlayerCount {
    if (!running) {
      this.pending?.abort();
      this.pending = undefined;
      this.currentVersion = undefined;
      this.lastAttempt = -Infinity;
      this.value = { online: 0, max: null, names: [] };
      return { ...this.value };
    }
    if (this.currentVersion !== version) {
      this.pending?.abort();
      this.pending = undefined;
      this.currentVersion = version;
      this.lastAttempt = -Infinity;
      this.value = { ...unknown };
    }
    if (!this.pending && this.now() - this.lastAttempt >= 5000) {
      const request = new AbortController();
      this.pending = request;
      this.lastAttempt = this.now();
      void this.query(version, request.signal).then(value => {
        if (this.pending === request) this.value = value;
      }, () => {
        if (this.pending === request) this.value = { ...unknown };
      }).finally(() => { if (this.pending === request) this.pending = undefined; });
    }
    return { ...this.value };
  }
}
