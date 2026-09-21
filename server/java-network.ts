import { isIPv4 } from 'node:net';

export function javaProxyArguments(address: string, port: 3128 | 3129): string[] {
  if (!isIPv4(address) || !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address)) throw new Error('The sandbox proxy must have a fixed private IPv4 address.');
  return [`-Dhttp.proxyHost=${address}`, `-Dhttp.proxyPort=${port}`, `-Dhttps.proxyHost=${address}`, `-Dhttps.proxyPort=${port}`, '-Dhttp.nonProxyHosts='];
}
