import { describe, expect, it } from 'vitest';

import { isNonPublicIp } from './addresses.js';
import { parseDnsx, parseNaabu } from './parse.js';

describe('parseDnsx', () => {
  it('reads A and AAAA answers in order, canonicalised and de-duplicated', () => {
    const out = [
      JSON.stringify({
        host: 'WWW.Lab.Example.',
        a: ['203.0.113.7', '203.0.113.7'],
        aaaa: ['2001:DB8:0:0:0:0:0:1'],
        status_code: 'NOERROR',
        extra: { ignored: true },
      }),
      '',
      JSON.stringify({ host: 'api.lab.example', a: ['198.51.100.9'] }),
    ].join('\n');
    expect(parseDnsx(out)).toEqual({
      records: [
        { host: 'www.lab.example', ips: ['203.0.113.7', '2001:db8::1'] },
        { host: 'api.lab.example', ips: ['198.51.100.9'] },
      ],
      malformed: 0,
    });
  });

  it('gives a non-NOERROR answer no addresses and drops non-IP answers', () => {
    const out = [
      JSON.stringify({ host: 'gone.lab.example', status_code: 'NXDOMAIN', a: ['203.0.113.1'] }),
      JSON.stringify({ host: 'odd.lab.example', a: ['not-an-ip', '203.0.113.2'] }),
    ].join('\n');
    expect(parseDnsx(out).records).toEqual([
      { host: 'gone.lab.example', ips: [] },
      { host: 'odd.lab.example', ips: ['203.0.113.2'] },
    ]);
  });

  it('counts malformed lines without echoing them', () => {
    const out = ['{broken', JSON.stringify({ nohost: 1 }), JSON.stringify({ host: 'bad host!' })];
    expect(parseDnsx(out.join('\n'))).toEqual({ records: [], malformed: 3 });
  });
});

describe('parseNaabu', () => {
  it('reads ip, port and protocol, defaulting to tcp and falling back to host', () => {
    const out = [
      JSON.stringify({ ip: '203.0.113.7', port: 443, protocol: 'tcp', host: 'x' }),
      JSON.stringify({ host: '203.0.113.7', port: 80 }),
    ].join('\n');
    expect(parseNaabu(out).records).toEqual([
      { ip: '203.0.113.7', port: 443, proto: 'tcp' },
      { ip: '203.0.113.7', port: 80, proto: 'tcp' },
    ]);
  });

  it('rejects out-of-range ports, non-IP addresses and unknown protocols', () => {
    const out = [
      JSON.stringify({ ip: '203.0.113.7', port: 0 }),
      JSON.stringify({ ip: '203.0.113.7', port: 65_536 }),
      JSON.stringify({ ip: 'host.example', port: 80 }),
      JSON.stringify({ ip: '203.0.113.7', port: 80, protocol: 'sctp' }),
      JSON.stringify({ port: 80 }),
      'not json',
    ].join('\n');
    expect(parseNaabu(out)).toEqual({ records: [], malformed: 6 });
  });
});

describe('isNonPublicIp', () => {
  it.each([
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    'garbage',
  ])('treats %s as non-public', (ip) => {
    expect(isNonPublicIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '203.0.113.7', '172.32.0.1', '2606:4700::1111'])(
    'treats %s as public',
    (ip) => {
      expect(isNonPublicIp(ip)).toBe(false);
    },
  );
});
