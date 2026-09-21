import { execFile } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const routerNetwork = Object.freeze({
  networkInterface: 'en0',
  gateway: '192.168.1.1',
  descriptionUrl: 'http://192.168.1.1:5000/rootDesc.xml',
});
export const managedMappings = Object.freeze([
  { externalPort: 80, internalPort: 8080, description: 'aron.best-http' },
  { externalPort: 443, internalPort: 8443, description: 'aron.best-https' },
  { externalPort: 25565, internalPort: 25565, description: 'aron.best-minecraft' },
]);
const leaseSeconds = 3600;
const renewalMilliseconds = 15 * 60 * 1000;
// After a network drop, keep checking every minute so mappings return as soon as the router is back.
const retryMilliseconds = 60 * 1000;
export const publicHostnames = Object.freeze(['aron.best', 'mc.aron.best']);

/** Reports whether public DNS still points at this connection. Residential addresses can change. */
export async function inspectDns(externalAddress) {
  const stale = [];
  for (const hostname of publicHostnames) {
    const addresses = await resolve4(hostname).catch(() => []);
    if (!addresses.includes(externalAddress)) stale.push({ hostname, addresses });
  }
  return { externalAddress, stale };
}

function xmlValue(xml, tag) {
  const value = xml.match(new RegExp(`<${tag}\\b[^>]*>\\s*([^<]+?)\\s*</${tag}>`, 'i'))?.[1];
  if (!value) throw new Error(`Router description has no ${tag}.`);
  return value.trim();
}

export function parseRouterDescription(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Router description contains unsupported XML declarations.');
  const origin = new URL(routerNetwork.descriptionUrl).origin;
  const base = xml.match(/<URLBase\b[^>]*>\s*([^<]+?)\s*<\/URLBase>/i)?.[1] ?? routerNetwork.descriptionUrl;
  if (new URL(base).origin !== origin) throw new Error('Router description points outside the expected gateway.');
  for (const match of xml.matchAll(/<controlURL\b[^>]*>\s*([^<]+?)\s*<\/controlURL>/gi)) {
    if (new URL(match[1], base).origin !== origin) throw new Error('Router control URL points outside the expected gateway.');
  }
  const identity = { udn: xmlValue(xml, 'UDN'), manufacturer: xmlValue(xml, 'manufacturer'), modelName: xmlValue(xml, 'modelName') };
  if (!/^uuid:[a-zA-Z0-9-]+$/.test(identity.udn)) throw new Error('Router UDN has an unexpected format.');
  return identity;
}

export async function inspectRouterNetwork(signal) {
  const { stdout } = await execute('/sbin/route', ['-n', 'get', 'default'], { timeout: 10_000, maxBuffer: 32 * 1024, signal });
  const gateway = stdout.match(/^\s*gateway:\s*(\S+)\s*$/m)?.[1];
  const networkInterface = stdout.match(/^\s*interface:\s*(\S+)\s*$/m)?.[1];
  if (gateway !== routerNetwork.gateway || networkInterface !== routerNetwork.networkInterface) {
    throw new Error('Default route is not the pinned GFiber gateway on en0. No mappings were changed.');
  }
  const addresses = (networkInterfaces()[networkInterface] ?? []).filter(address => address.family === 'IPv4' && !address.internal);
  if (addresses.length !== 1) throw new Error('Expected exactly one active IPv4 address on en0.');
  const address = addresses[0].address;
  if (!/^192\.168\.1\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(address) || address === routerNetwork.gateway) {
    throw new Error('The current en0 IPv4 address is outside the pinned GFiber LAN.');
  }
  return address;
}

export async function inspectRouterIdentity(signal) {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(routerNetwork.descriptionUrl, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok || !response.body) throw new Error(`Router description request failed (${response.status}).`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 256 * 1024) throw new Error('Router description exceeds the expected size.');
    chunks.push(chunk);
  }
  return parseRouterDescription(Buffer.concat(chunks).toString('utf8'));
}

export function parseMappingTable(output, localAddress) {
  const controlUrl = output.match(/Found valid IGD\s*:\s*(\S+)/)?.[1];
  if (!controlUrl || new URL(controlUrl).origin !== new URL(routerNetwork.descriptionUrl).origin) throw new Error('UPnP did not report the pinned gateway.');
  if (output.match(/Local LAN ip address\s*:\s*(\S+)/i)?.[1] !== localAddress) throw new Error('UPnP selected a different local address.');
  const lines = output.split('\n');
  const header = lines.findIndex(line => /^\s*i\s+protocol\s+exPort->inAddr:inPort\s+description\s+remoteHost\s+leaseTime\s*$/.test(line));
  if (header < 0) throw new Error('The router mapping table header is missing.');
  const mappings = [];
  for (const line of lines.slice(header + 1)) {
    if (!line.trim() || /^GetGenericPortMappingEntry\(\) returned 713\b/.test(line)) continue;
    const fields = line.match(/^\s*\d+\s+(TCP|UDP)\s+(\d+)->([\d.]+):(\d+)\s+'(.*)'\s+'([^']*)'\s+(\d+)\s*$/);
    if (!fields) throw new Error('The router returned an unreadable mapping entry.');
    mappings.push({ protocol: fields[1], externalPort: Number(fields[2]), address: fields[3], internalPort: Number(fields[4]), description: fields[5], remoteHost: fields[6], leaseSeconds: Number(fields[7]) });
  }
  return { mappings, externalAddress: output.match(/ExternalIPAddress\s*=\s*(\S+)/)?.[1] ?? null };
}

export function assertOwnedMappings(mappings, address) {
  for (const expected of managedMappings) {
    const matches = mappings.filter(mapping => mapping.protocol === 'TCP' && mapping.externalPort === expected.externalPort);
    if (matches.length > 1) throw new Error(`Multiple TCP mappings exist for public port ${expected.externalPort}. No mappings were changed.`);
    for (const mapping of matches) {
      if (mapping.address !== address || mapping.internalPort !== expected.internalPort || mapping.description !== expected.description || mapping.remoteHost !== '') {
        throw new Error(`TCP port ${expected.externalPort} belongs to a different target or description. Existing mapping preserved.`);
      }
      if (mapping.leaseSeconds === 0 || mapping.leaseSeconds > leaseSeconds) throw new Error(`TCP port ${expected.externalPort} has an unexpected permanent or extended lease. Existing mapping preserved.`);
    }
  }
}

async function readMappings(settings, address, signal) {
  const { stdout, stderr } = await execute(settings.upnpcBinary, ['-u', routerNetwork.descriptionUrl, '-m', routerNetwork.networkInterface, '-l'], { timeout: 15_000, maxBuffer: 512 * 1024, signal });
  return parseMappingTable(`${stdout}\n${stderr}`, address);
}

export async function renewMappings(settings, signal) {
  const address = await inspectRouterNetwork(signal);
  const identity = await inspectRouterIdentity(signal);
  if (identity.udn !== settings.identity.udn || identity.manufacturer !== settings.identity.manufacturer || identity.modelName !== settings.identity.modelName) {
    throw new Error('The router identity changed. No mappings were changed. Inspect the new router before pinning it.');
  }
  const initial = await readMappings(settings, address, signal);
  assertOwnedMappings(initial.mappings, address);
  for (const mapping of managedMappings) {
    if (await inspectRouterNetwork(signal) !== address) throw new Error('The local address changed during renewal. Remaining mappings were left untouched.');
    const current = await readMappings(settings, address, signal);
    assertOwnedMappings(current.mappings, address);
    await execute(settings.upnpcBinary, ['-u', routerNetwork.descriptionUrl, '-m', routerNetwork.networkInterface, '-e', mapping.description, '-a', address, String(mapping.internalPort), String(mapping.externalPort), 'TCP', String(leaseSeconds)], { timeout: 15_000, maxBuffer: 128 * 1024, signal });
    const verified = await readMappings(settings, address, signal);
    assertOwnedMappings(verified.mappings, address);
    if (!verified.mappings.some(entry => entry.protocol === 'TCP' && entry.externalPort === mapping.externalPort)) {
      throw new Error(`Router did not retain the requested TCP ${mapping.externalPort} mapping.`);
    }
  }
  return { address, externalAddress: initial.externalAddress, ports: managedMappings.map(mapping => mapping.externalPort), leaseSeconds };
}

async function main(settingsPath) {
  if (!settingsPath || !isAbsolute(settingsPath)) throw new Error('Provide an absolute router-settings.json path.');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  if (!isAbsolute(settings.upnpcBinary) || !isAbsolute(settings.statusPath) || !settings.identity?.udn) throw new Error('Router settings are incomplete. Rerun the service installer with --with-router.');
  const shutdown = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => shutdown.abort());
  let lastSuccessAt = null;
  let lastDnsWarning = '';
  while (!shutdown.signal.aborted) {
    let state;
    let wait = renewalMilliseconds;
    try {
      const result = await renewMappings(settings, shutdown.signal);
      lastSuccessAt = new Date().toISOString();
      const dns = result.externalAddress ? await inspectDns(result.externalAddress) : { externalAddress: null, stale: [] };
      state = { status: 'ready', checkedAt: lastSuccessAt, lastSuccessAt, ...result, dns };
      console.log(`${lastSuccessAt} Renewed three GFiber TCP mappings for ${result.address} with one-hour leases.`);
      const warning = dns.stale.map(entry => `${entry.hostname} -> ${entry.addresses.join(', ') || 'no answer'}`).join('; ');
      if (warning && warning !== lastDnsWarning) console.error(`${lastSuccessAt} Public DNS does not point at ${result.externalAddress}: ${warning}. Update the Squarespace records.`);
      lastDnsWarning = warning;
    } catch (error) {
      if (shutdown.signal.aborted) break;
      const message = error instanceof Error ? error.message : 'Unknown router renewal failure';
      state = { status: 'blocked', checkedAt: new Date().toISOString(), lastSuccessAt, message };
      console.error(`${state.checkedAt} Router renewal blocked: ${message}`);
      wait = retryMilliseconds;
    }
    const temporary = `${settings.statusPath}.part`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, settings.statusPath);
    try { await delay(wait, undefined, { signal: shutdown.signal }); } catch (error) { if (!shutdown.signal.aborted) throw error; }
  }
  console.log('Router renewal stopped. No mappings were deleted; existing leases expire on the router.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
