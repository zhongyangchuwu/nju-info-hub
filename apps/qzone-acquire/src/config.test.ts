import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseQzonePolicy, parseQzoneRuntimeConfig } from './config.js';

const policyFixture = parseQzonePolicy(JSON.parse(readFileSync(new URL('./fixtures/policy.json', import.meta.url), 'utf8')));

const env = {
  QZONE_ASTRBOT_URL: 'http://127.0.0.1:6185', QZONE_ASTRBOT_TOKEN: 'synthetic-service-token',
  QZONE_ASTRBOT_VERSION: 'synthetic-astrbot-revision', QZONE_PLUGIN_VERSION: 'synthetic-plugin-revision',
  QZONE_PROTECTED_ROOT: '/synthetic/platform-state',
};

describe('collector-only configuration', () => {
  it('requires explicit endpoint, bearer capability, reviewed provider versions and protected-root declaration', () => {
    expect(parseQzoneRuntimeConfig(env)).toEqual({
      origin: env.QZONE_ASTRBOT_URL, token: env.QZONE_ASTRBOT_TOKEN,
      astrbotVersion: env.QZONE_ASTRBOT_VERSION, pluginVersion: env.QZONE_PLUGIN_VERSION,
      protectedRoot: env.QZONE_PROTECTED_ROOT,
    });
    for (const key of Object.keys(env)) expect(() => parseQzoneRuntimeConfig({ ...env, [key]: '' })).toThrow();
  });

  it.each([
    'http://collector.example', 'https://user:password@collector.example',
    'https://collector.example/path', 'https://collector.example?token=synthetic',
    'https://collector.example/#session', ' https://collector.example',
  ])('rejects unsafe or ambiguous origin %s without echoing it', (origin) => {
    try {
      parseQzoneRuntimeConfig({ ...env, QZONE_ASTRBOT_URL: origin });
      expect.fail('unsafe origin accepted');
    } catch (error) {
      expect(String(error)).not.toContain(origin);
    }
  });

  it('rejects control characters in bearer tokens without echoing them', () => {
    expect(() => parseQzoneRuntimeConfig({ ...env, QZONE_ASTRBOT_TOKEN: 'synthetic\nsecret' })).toThrow('Invalid QZONE_ASTRBOT_TOKEN');
  });

  it.each(['relative/platform-state', ' ', '/synthetic/state\u0000', '/synthetic/state\n'])('rejects invalid protected-root declarations without echoing them', (protectedRoot) => {
    expect(() => parseQzoneRuntimeConfig({ ...env, QZONE_PROTECTED_ROOT: protectedRoot })).toThrow('QZONE_PROTECTED_ROOT must be an absolute platform state/session root');
  });

  it('normalizes declared paths without accessing platform storage', () => {
    expect(parseQzoneRuntimeConfig({ ...env, QZONE_PROTECTED_ROOT: '/synthetic/unused/../platform-state/' }).protectedRoot).toBe('/synthetic/platform-state');
  });

  it('requires non-expired explicit publisher, audience, content scope and rights qualification', () => {
    expect(parseQzonePolicy(policyFixture, new Date('2026-10-07'))).toEqual(policyFixture);
    expect(() => parseQzonePolicy({ ...policyFixture, qualification: { ...policyFixture.qualification, reviewUntil: '2026-10-07T00:00:00Z' } }, new Date('2026-10-07'))).toThrow('not currently valid');
    expect(() => parseQzonePolicy({ ...policyFixture, qualification: { ...policyFixture.qualification, reviewedAt: '2027-01-01T00:00:00Z' } }, new Date('2026-10-07'))).toThrow('not currently valid');
    expect(() => parseQzonePolicy({ ...policyFixture, qualification: { ...policyFixture.qualification, redistributionBasis: '' } })).toThrow('Invalid QZone source policy');
  });

  it.each([
    { platform: 'wechat' }, { audience: 'friends' }, { access: 'anonymous' },
    { redistributionMode: 'denied' }, { role: 'sentinel', redistributionMode: 'full' },
    { publisherIdentity: { scheme: 'wechat-biz', version: 1, value: 'YWJj' } },
    { token: 'synthetic-secret' },
  ])('rejects ineligible or credential-bearing source policy %j', (change) => {
    expect(() => parseQzonePolicy({ ...policyFixture, source: { ...policyFixture.source, ...change } })).toThrow();
  });
});
