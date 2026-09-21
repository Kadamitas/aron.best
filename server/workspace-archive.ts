import { crc32 } from 'node:zlib';

export const maximumArchiveBytes = 128 * 1024 * 1024;

export function workspaceArchive(entries: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  if (entries.length > 1201) throw new Error('The modpack archive has too many files.');
  const names = entries.map(([name]) => {
    if (!name || name.startsWith('/') || /[\\\x00-\x1f\x7f:]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('The modpack archive contains an unsafe file path.');
    const bytes = Buffer.from(name, 'utf8');
    if (bytes.length > 65535) throw new Error('The modpack archive contains a file path that is too long.');
    return bytes;
  });
  const size = entries.reduce((total, [, contents], index) => total + 76 + names[index]!.length * 2 + contents.length, 22);
  if (size > maximumArchiveBytes) throw Object.assign(new Error('The modpack archive is limited to 128 MiB.'), { statusCode: 413 });
  const archive = Buffer.alloc(size);
  const directory: Array<{ name: Buffer; size: number; checksum: number; offset: number }> = [];
  let offset = 0;
  for (const [index, [, contents]] of entries.entries()) {
    const name = names[index]!;
    const checksum = crc32(contents);
    directory.push({ name, size: contents.length, checksum, offset });
    archive.writeUInt32LE(0x04034b50, offset);
    archive.writeUInt16LE(20, offset + 4);
    archive.writeUInt16LE(0x0800, offset + 6);
    archive.writeUInt16LE(33, offset + 12);
    archive.writeUInt32LE(checksum, offset + 14);
    archive.writeUInt32LE(contents.length, offset + 18);
    archive.writeUInt32LE(contents.length, offset + 22);
    archive.writeUInt16LE(name.length, offset + 26);
    name.copy(archive, offset + 30);
    contents.copy(archive, offset + 30 + name.length);
    offset += 30 + name.length + contents.length;
  }
  const directoryOffset = offset;
  for (const entry of directory) {
    archive.writeUInt32LE(0x02014b50, offset);
    archive.writeUInt16LE(20, offset + 4);
    archive.writeUInt16LE(20, offset + 6);
    archive.writeUInt16LE(0x0800, offset + 8);
    archive.writeUInt16LE(33, offset + 14);
    archive.writeUInt32LE(entry.checksum, offset + 16);
    archive.writeUInt32LE(entry.size, offset + 20);
    archive.writeUInt32LE(entry.size, offset + 24);
    archive.writeUInt16LE(entry.name.length, offset + 28);
    archive.writeUInt32LE(entry.offset, offset + 42);
    entry.name.copy(archive, offset + 46);
    offset += 46 + entry.name.length;
  }
  archive.writeUInt32LE(0x06054b50, offset);
  archive.writeUInt16LE(directory.length, offset + 8);
  archive.writeUInt16LE(directory.length, offset + 10);
  archive.writeUInt32LE(offset - directoryOffset, offset + 12);
  archive.writeUInt32LE(directoryOffset, offset + 16);
  return archive;
}
