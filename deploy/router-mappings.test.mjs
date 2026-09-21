import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOwnedMappings, managedMappings, parseMappingTable, parseRouterDescription } from './router-mappings.mjs';

const localAddress = '192.168.1.106';
const table = entries => `Found valid IGD : http://192.168.1.1:5000/ctl/IPConn\nLocal LAN ip address : ${localAddress}\nExternalIPAddress = 203.0.113.10\n i protocol exPort->inAddr:inPort description remoteHost leaseTime\n${entries}\nGetGenericPortMappingEntry() returned 713 (SpecifiedArrayIndexInvalid)`;
const row = (port, internalPort, description, address = localAddress, lease = 3600) => ` 0 TCP ${port}->${address}:${internalPort} '${description}' '' ${lease}`;

test('only the three owned TCP mappings can be renewed', () => {
  const expected = managedMappings.map(mapping => row(mapping.externalPort, mapping.internalPort, mapping.description)).join('\n');
  const parsed = parseMappingTable(table(expected), localAddress);
  assert.equal(parsed.mappings.length, 3);
  assert.doesNotThrow(() => assertOwnedMappings(parsed.mappings, localAddress));
  assert.doesNotThrow(() => assertOwnedMappings([], localAddress));
  assert.doesNotThrow(() => assertOwnedMappings([{ protocol: 'UDP', externalPort: 80, address: '192.168.1.20' }], localAddress));
});

test('same-port conflicts and permanent leases are preserved, never adopted', () => {
  for (const entry of [
    row(80, 8080, 'another-application'),
    row(80, 80, 'aron.best-http', '192.168.1.20'),
    row(80, 9000, 'aron.best-http'),
    row(80, 80, 'aron.best-http', localAddress, 0),
    row(80, 80, 'aron.best-http', localAddress, 7200),
  ]) assert.throws(() => assertOwnedMappings(parseMappingTable(table(entry), localAddress).mappings, localAddress));
});

test('truncated or ambiguous table output cannot authorize mapping writes', () => {
  assert.throws(() => parseMappingTable(table('').replace('returned 713', 'returned 501'), localAddress));
  assert.throws(() => parseMappingTable(table('').replace('192.168.1.1:5000', '192.168.1.9:5000'), localAddress));
  assert.throws(() => parseMappingTable(table(' 0 TCP malformed'), localAddress));
  assert.throws(() => parseMappingTable(table(''), '192.168.1.105'));
  assert.throws(() => parseMappingTable(table('').replace(' i protocol exPort->inAddr:inPort description remoteHost leaseTime\n', ''), localAddress));
  const duplicate = row(80, 80, 'aron.best-http');
  assert.throws(() => assertOwnedMappings(parseMappingTable(table(`${duplicate}\n${duplicate}`), localAddress).mappings, localAddress));
});

test('miniupnpc 2.3.3 successful empty output needs no legacy 713 terminator', () => {
  const output = `upnpc: miniupnpc library test client, version 2.3.3.\nFound valid IGD : http://192.168.1.1:5000/ctl/IPConn\nLocal LAN ip address : 192.168.1.106\nExternalIPAddress = 203.0.113.10\n i protocol exPort->inAddr:inPort description remoteHost leaseTime\n`;
  assert.deepEqual(parseMappingTable(output, localAddress), { mappings: [], externalAddress: '203.0.113.10' });
  assert.throws(() => parseMappingTable(`${output}GetGenericPortMappingEntry() returned 501 (ActionFailed)\n`, localAddress));
});

test('router identity rejects external control endpoints and XML entities', () => {
  const xml = '<root><device><manufacturer>Google</manufacturer><modelName>GRBE331C</modelName><UDN>uuid:router-fixture</UDN><service><controlURL>/ctl/IPConn</controlURL></service></device></root>';
  assert.deepEqual(parseRouterDescription(xml), { udn: 'uuid:router-fixture', manufacturer: 'Google', modelName: 'GRBE331C' });
  assert.throws(() => parseRouterDescription(xml.replace('/ctl/IPConn', 'http://attacker.invalid/control')));
  assert.throws(() => parseRouterDescription(`<!DOCTYPE root>${xml}`));
  assert.throws(() => parseRouterDescription(xml.replace('<UDN>uuid:router-fixture</UDN>', '')));
});
