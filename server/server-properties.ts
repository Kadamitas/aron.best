import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const maximumBytes = 64 * 1024;
const protectedKeys = new Set(['online-mode', 'server-ip', 'server-port', 'level-name']);
const whitespace = (value: string | undefined) => value === ' ' || value === '\t' || value === '\f';

export class ServerPropertiesError extends Error {
  readonly statusCode = 409;
}

function decode(source: string): string {
  let result = '';
  for (let index = 0; index < source.length; index++) {
    let character = source[index]!;
    if (character === '\\') {
      character = source[++index] ?? '';
      if (character === 'u') {
        const digits = source.slice(index + 1, index + 5);
        if (!/^[a-fA-F0-9]{4}$/.test(digits)) throw new ServerPropertiesError('server.properties contains a malformed Unicode escape.');
        character = String.fromCharCode(Number.parseInt(digits, 16));
        index += 4;
      } else if (character === 't') character = '\t';
      else if (character === 'r') character = '\r';
      else if (character === 'n') character = '\n';
      else if (character === 'f') character = '\f';
    }
    result += character;
  }
  return result;
}

function* logicalLines(source: string): Generator<string> {
  let logical = '';
  let continued = false;
  for (const natural of source.split(/\r\n|\r|\n/)) {
    let start = 0;
    while (whitespace(natural[start])) start++;
    if (!continued && (start === natural.length || natural[start] === '#' || natural[start] === '!')) continue;
    logical += natural.slice(start);
    let slashes = 0;
    for (let index = logical.length - 1; index >= 0 && logical[index] === '\\'; index--) slashes++;
    continued = slashes % 2 === 1;
    if (continued) logical = logical.slice(0, -1);
    else { yield logical; logical = ''; }
  }
  if (continued || logical) yield logical;
}

function protectedProperties(source: string): Map<string, string> {
  if (Buffer.byteLength(source, 'utf8') > maximumBytes) throw new ServerPropertiesError('server.properties is limited to 64 KiB.');
  const properties = new Map<string, string>();
  for (const line of logicalLines(source)) {
    let end = 0;
    let escaped = false;
    while (end < line.length) {
      const character = line[end]!;
      if (!escaped && (character === '=' || character === ':' || whitespace(character))) break;
      escaped = character === '\\' ? !escaped : false;
      end++;
    }
    let value = end;
    while (whitespace(line[value])) value++;
    if (line[value] === '=' || line[value] === ':') value++;
    while (whitespace(line[value])) value++;
    const key = decode(line.slice(0, end));
    const contents = decode(line.slice(value));
    if (!protectedKeys.has(key)) continue;
    if (properties.has(key)) throw new ServerPropertiesError(`server.properties contains duplicate ${key} settings.`);
    properties.set(key, contents);
  }
  return properties;
}

export function assertSandboxServerProperties(source: string): void {
  const values = protectedProperties(source);
  if (values.get('online-mode') !== 'true' || values.get('server-ip') !== '127.0.0.1' || values.get('server-port') !== '25566') {
    throw new ServerPropertiesError('The protected Minecraft listener requires online-mode=true, server-ip=127.0.0.1 and server-port=25566.');
  }
  if (values.has('level-name') && values.get('level-name') !== 'world') throw new ServerPropertiesError('The hardened runtime requires level-name=world. Custom world paths are not allowed.');
}

export async function readServerProperties(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumBytes) throw new ServerPropertiesError('server.properties must be a regular unlinked file no larger than 64 KiB.');
    const bytes = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(file);
    if (!after.isFile() || after.nlink !== 1 || !current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino || offset !== before.size || before.size !== after.size || before.ctimeMs !== after.ctimeMs || current.ctimeMs !== after.ctimeMs) throw new ServerPropertiesError('server.properties changed while it was read.');
    return bytes.subarray(0, offset).toString('utf8');
  } finally { await handle.close(); }
}
