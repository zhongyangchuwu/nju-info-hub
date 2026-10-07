import { describe, expect, it } from 'vitest';
import { parseGatewayConfig, type GatewayConfig } from './config.js';

const env = {
  QZONE_GATEWAY_UPSTREAM_URL: 'http://127.0.0.1:6185',
  QZONE_GATEWAY_UPSTREAM_TOKEN: 'synthetic-upstream-token',
  QZONE_GATEWAY_READER_TOKEN: 'synthetic-reader-token',
  QZONE_GATEWAY_PUBLISHER_UINS: '123456789,987654321',
  QZONE_GATEWAY_HOST: '127.0.0.1',
  QZONE_GATEWAY_PORT: '0',
};

const expectedConfig: GatewayConfig = {
  upstreamOrigin: 'http://127.0.0.1:6185', upstreamToken: env.QZONE_GATEWAY_UPSTREAM_TOKEN,
  readerToken: env.QZONE_GATEWAY_READER_TOKEN, publisherUins: ['123456789', '987654321'],
  host: '127.0.0.1', port: 0,
};

describe('QZone gateway configuration', () => {
  it('requires every explicit environment setting and canonicalizes an origin and publisher list', () => {
    expect(parseGatewayConfig(env)).toEqual(expectedConfig);
    for (const key of Object.keys(env)) {
      expect(() => parseGatewayConfig({ ...env, [key]: '' })).toThrow('Invalid QZone gateway configuration');
      const omitted = Object.fromEntries(Object.entries(env).filter(([name]) => name !== key));
      expect(() => parseGatewayConfig(omitted)).toThrow('Invalid QZone gateway configuration');
    }
    expect(() => parseGatewayConfig({})).toThrow('Invalid QZone gateway configuration');
  });

  it.each([
    'http://service.example', 'https://service.example/path', 'https://service.example/a/../',
    'https://service.example/%2e%2e', 'https://service.example?key=synthetic',
    'https://service.example/#synthetic', 'https://user:password@service.example',
    'https://@service.example', ' https://service.example', 'https://service.example\n',
    'ftp://127.0.0.1', 'http://192.0.2.10',
  ])('rejects unsafe upstream origin %s without echoing supplied input', (origin) => {
    expect(() => parseGatewayConfig({ ...env, QZONE_GATEWAY_UPSTREAM_URL: origin }))
      .toThrow('Invalid QZone gateway configuration');
    try {
      parseGatewayConfig({ ...env, QZONE_GATEWAY_UPSTREAM_URL: origin });
    } catch (error) {
      expect(String(error)).not.toContain(origin);
      expect(String(error)).not.toContain(env.QZONE_GATEWAY_UPSTREAM_TOKEN);
    }
  });

  it.each(['https://service.example', 'http://localhost', 'http://127.0.0.1', 'http://[::1]:6185'])
  ('accepts HTTPS remote or HTTP loopback origin %s', (origin) => {
    expect(parseGatewayConfig({ ...env, QZONE_GATEWAY_UPSTREAM_URL: origin }).upstreamOrigin).toBe(new URL(origin).origin);
  });

  it.each([
    { QZONE_GATEWAY_UPSTREAM_TOKEN: 'same', QZONE_GATEWAY_READER_TOKEN: 'same' },
    { QZONE_GATEWAY_UPSTREAM_TOKEN: 'synthetic\nsecret' },
    { QZONE_GATEWAY_READER_TOKEN: 'synthetic\rsecret' },
    { QZONE_GATEWAY_READER_TOKEN: 'token with space' },
    { QZONE_GATEWAY_UPSTREAM_TOKEN: 'token:colon' },
  ])('rejects equal or non-bearer credentials without revealing them', (change) => {
    try {
      parseGatewayConfig({ ...env, ...change });
      expect.fail('invalid credentials accepted');
    } catch (error) {
      expect(String(error)).toBe('Error: Invalid QZone gateway configuration');
      for (const value of Object.values(change)) expect(String(error)).not.toContain(value);
    }
  });

  it.each(['', ' ', ',123456789', '123456789,', '123456789,,987654321',
    '0123456789', '0', '-1', '123456789,123456789', '123456789, 123456789'])
  ('rejects empty, duplicate, or non-canonical publisher UIN list %j', (uins) => {
    expect(() => parseGatewayConfig({ ...env, QZONE_GATEWAY_PUBLISHER_UINS: uins }))
      .toThrow('Invalid QZone gateway configuration');
  });

  it('trims UIN list entries while preserving canonical identities', () => {
    expect(parseGatewayConfig({ ...env, QZONE_GATEWAY_PUBLISHER_UINS: ' 123456789 , 987654321 ' }).publisherUins)
      .toEqual(['123456789', '987654321']);
  });

  it.each(['', '0', '65535', '65536', '-1', '+1', '01', '1.5', '1e2', ' 80'])
  ('accepts only explicit canonical listener ports in range: %j', (port) => {
    const acceptable = port === '0' || port === '65535';
    if (acceptable) expect(parseGatewayConfig({ ...env, QZONE_GATEWAY_PORT: port }).port).toBe(Number(port));
    else expect(() => parseGatewayConfig({ ...env, QZONE_GATEWAY_PORT: port })).toThrow('Invalid QZone gateway configuration');
  });

  it.each(['localhost', '127.0.0.1', '0.0.0.0', '::1'])('accepts explicit listener host %s', (host) => {
    expect(parseGatewayConfig({ ...env, QZONE_GATEWAY_HOST: host }).host).toBe(host);
  });

  it.each(['', 'example.invalid', 'https://localhost', '127.0.0.1:80'])
  ('rejects missing or non-literal listener host %j', (host) => {
    expect(() => parseGatewayConfig({ ...env, QZONE_GATEWAY_HOST: host })).toThrow('Invalid QZone gateway configuration');
  });
});
