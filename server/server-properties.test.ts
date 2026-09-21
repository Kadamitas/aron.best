import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSandboxServerProperties, readServerProperties, ServerPropertiesError } from './server-properties.js';

const required = 'online-mode=true\nserver-ip=127.0.0.1\nserver-port=25566\n';

test('protected server properties accept Java separators, escaped characters and mixed line endings', () => {
  for (const source of [
    required,
    `${required}level-name=world\n`,
    'online-mode : true\r\nserver-ip\t127.0.0.1\rserver-port\f=\f25566\nlevel-name world',
    ' online-mode=true\n\tserver-ip : 127.0.0.1\n\fserver-port 25566',
    String.raw`onlin\e\-mode=\u0074rue` + '\n' + String.raw`server\-ip=127.0.0.\u0031` + '\n' + String.raw`server-port=\u0032\u0035\u0035\u0036\u0036`,
  ]) assert.doesNotThrow(() => assertSandboxServerProperties(source));
});

test('protected property continuations follow Java logical lines rather than matching individual physical lines', () => {
  assert.doesNotThrow(() => assertSandboxServerProperties('onli\\\nne-mode=tr\\\n \t\fue\nserver-ip=127.0.\\\r\n  0.1\nserver-port=255\\\r66\n'));
  assert.doesNotThrow(() => assertSandboxServerProperties(`${required}motd=hello\\\nonline-mode=false\n`));
  assert.doesNotThrow(() => assertSandboxServerProperties(`${required}motd=hello\\\n#still part of the value\n`));
  assert.doesNotThrow(() => assertSandboxServerProperties(`${required}level-name=world\\`));
  assert.throws(() => assertSandboxServerProperties('online-mode=true\\\nserver-ip=127.0.0.1\nserver-port=25566\n'), /protected Minecraft listener/);
  assert.throws(() => assertSandboxServerProperties(`${required}level-name=wo\\\n\nrld`), /level-name=world/);
  assert.throws(() => assertSandboxServerProperties(`${required}online-mo\\\n de=false\n`), /duplicate online-mode/);
  assert.throws(() => assertSandboxServerProperties('online-mode=true\\\\\nserver-ip=127.0.0.1\nserver-port=25566\n'), /protected Minecraft listener/);
});

test('protected keys reject every duplicate including escaped spellings and matching values', () => {
  for (const [key, encoded, value] of [
    ['online-mode', String.raw`\u006fnline-mode`, 'false'],
    ['server-ip', String.raw`server-\u0069p`, '0.0.0.0'],
    ['server-port', String.raw`server\-port`, '25565'],
    ['level-name', String.raw`level-na\me`, '../outside'],
  ]) {
    const source = `${required}level-name=world\n${encoded}:${value}\n`;
    assert.throws(() => assertSandboxServerProperties(source), new RegExp(`duplicate ${key}`));
  }
  assert.throws(() => assertSandboxServerProperties(`${required}online-mode=true\n`), /duplicate online-mode/);
  assert.throws(() => assertSandboxServerProperties(`online-mode:false\n${required}`), /duplicate online-mode/);
});

test('comments are recognized only at natural-line start and cannot conceal duplicate settings', () => {
  assert.doesNotThrow(() => assertSandboxServerProperties(` # online-mode=false\n\t!server-ip=0.0.0.0\n${required}`));
  assert.doesNotThrow(() => assertSandboxServerProperties(`${required}motd=literal#value!with:separators\n`));
  assert.doesNotThrow(() => assertSandboxServerProperties(`${required}motd=first\nmotd=second\n`));
  assert.throws(() => assertSandboxServerProperties(`# comment cannot continue\\\nonline-mode=false\n${required}`), /duplicate online-mode/);
  assert.throws(() => assertSandboxServerProperties('online-mode=true # not a comment\nserver-ip=127.0.0.1\nserver-port=25566\n'), /protected Minecraft listener/);
  assert.throws(() => assertSandboxServerProperties(`${required}level-name=world!not-comment`), /level-name=world/);
});

test('server listener and world paths reject unsafe values, empty values and whitespace ambiguity', () => {
  for (const source of [
    required.replace('online-mode=true', 'online-mode=false'),
    required.replace('server-ip=127.0.0.1', 'server-ip=0.0.0.0'),
    required.replace('server-port=25566', 'server-port=25565'),
    required.replace('online-mode=true', 'online-mode'),
    required.replace('server-ip=127.0.0.1', 'server-ip='),
    required.replace('true\n', 'true \n'),
    required.replace('online-mode=true', String.raw`online-mode=tr\nue`),
    required.replace('online-mode=true', String.raw`online-mode\ =true`),
    required.replace('online-mode=true', String.raw`online-mode\u003dtrue`),
    `${required}level-name=../outside`,
    `${required}level-name: /outside`,
    `${required}level-name=`,
    `${required}level-name=world `,
    `${required}level-name=\u0077orld\\\\outside`,
  ]) assert.throws(() => assertSandboxServerProperties(source), ServerPropertiesError);
});

test('server property parsing rejects malformed Unicode escapes and enforces its byte bound', () => {
  for (const suffix of [String.raw`motd=\uZZZZ`, String.raw`motd=\u123`, String.raw`motd=\uu0061`, String.raw`online\u0=anything`]) {
    assert.throws(() => assertSandboxServerProperties(`${required}${suffix}`), /malformed Unicode/);
  }
  const boundary = `${required}#${'x'.repeat(64 * 1024 - Buffer.byteLength(required) - 1)}`;
  assert.doesNotThrow(() => assertSandboxServerProperties(boundary));
  assert.throws(() => assertSandboxServerProperties(`${boundary}x`), /64 KiB/);
  assert.throws(() => assertSandboxServerProperties(`${required}#${'é'.repeat(33 * 1024)}`), /64 KiB/);
});

test('server properties are read with a file-size bound and without following links or opening special files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-server-properties-'));
  try {
    const regular = path.join(root, 'server.properties');
    await writeFile(regular, required);
    assert.equal(await readServerProperties(regular), required);
    const symbolic = path.join(root, 'symbolic.properties');
    await symlink(regular, symbolic);
    await assert.rejects(readServerProperties(symbolic));
    const hard = path.join(root, 'hard.properties');
    await link(regular, hard);
    await assert.rejects(readServerProperties(hard), /regular unlinked/);
    const directory = path.join(root, 'directory.properties');
    await mkdir(directory);
    await assert.rejects(readServerProperties(directory), /regular unlinked/);
    const oversized = path.join(root, 'oversized.properties');
    await writeFile(oversized, 'x'.repeat(64 * 1024 + 1));
    await assert.rejects(readServerProperties(oversized), /64 KiB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
