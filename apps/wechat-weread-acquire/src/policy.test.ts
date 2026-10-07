import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWechatSourcePolicy } from './policy.js';

const fixedNow = new Date('2026-10-07T13:00:00.000Z');

type PolicyFixture = {
  [key: string]: unknown;
  schemaVersion: unknown;
  source: {
    [key: string]: unknown;
    publisherIdentity: { [key: string]: unknown };
  };
  qualification: { [key: string]: unknown };
};

async function fixture(): Promise<PolicyFixture> {
  const path = fileURLToPath(new URL('./fixtures/source-policy.json', import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as PolicyFixture;
}

describe('parseWechatSourcePolicy', () => {
  it('accepts a deterministic official, public, review-only policy', async () => {
    const input = await fixture();
    const parsed = parseWechatSourcePolicy(input, fixedNow);

    expect(parsed.source).toMatchObject({
      sourceId: 'synthetic-wechat-official',
      platform: 'wechat',
      publisherIdentity: { scheme: 'wechat-biz', version: 1, value: 'MTIzNDU2Nzg5MA==' },
      displayName: 'Synthetic Official Publisher',
      role: 'official',
      access: 'credentialed-public',
      audience: 'public',
      redistributionMode: 'review-only',
      policyVersion: 'synthetic-review-v1',
    });
  });

  it.each(['full', 'summary', 'link-only', 'denied'] as const)(
    'rejects %s redistribution mode',
    async (redistributionMode) => {
      const input = await fixture();
      input.source.redistributionMode = redistributionMode;
      expect(() => parseWechatSourcePolicy(input, fixedNow)).toThrow();
    },
  );

  it.each([
    ['platform', (input: PolicyFixture) => { input.source.platform = 'qzone'; }],
    ['publisher scheme', (input: PolicyFixture) => {
      input.source.publisherIdentity = { scheme: 'qzone-uin', version: 1, value: '123456789' };
    }],
    ['access', (input: PolicyFixture) => { input.source.access = 'anonymous'; }],
    ['role', (input: PolicyFixture) => { input.source.role = 'relay'; }],
    ['audience', (input: PolicyFixture) => { input.source.audience = 'private'; }],
  ] as const)('rejects a non-Weread %s', async (_field, mutate) => {
    const input = await fixture();
    mutate(input);
    expect(() => parseWechatSourcePolicy(input, fixedNow)).toThrow();
  });

  it('rejects source identifiers or display names invalid under the core schema', async () => {
    const invalidId = await fixture();
    invalidId.source.sourceId = 'Synthetic Source';
    expect(() => parseWechatSourcePolicy(invalidId, fixedNow)).toThrow();

    const invalidDisplayName = await fixture();
    invalidDisplayName.source.displayName = '';
    expect(() => parseWechatSourcePolicy(invalidDisplayName, fixedNow)).toThrow();
  });

  it('rejects an unsupported schema version or blank policy version', async () => {
    const version = await fixture();
    version.schemaVersion = 2;
    expect(() => parseWechatSourcePolicy(version, fixedNow)).toThrow();
    const blank = await fixture();
    blank.source.policyVersion = ' \t ';
    expect(() => parseWechatSourcePolicy(blank, fixedNow)).toThrow();
  });

  it('rejects malformed publisher identity under the core schema', async () => {
    const input = await fixture();
    input.source.publisherIdentity.value = 'not canonical base64!';
    expect(() => parseWechatSourcePolicy(input, fixedNow)).toThrow();
  });

  it.each([
    ['root', (input: PolicyFixture) => { input.unexpected = 'credential'; }],
    ['source', (input: PolicyFixture) => { input.source.cookie = 'credential'; }],
    ['publisher identity', (input: PolicyFixture) => { input.source.publisherIdentity.token = 'credential'; }],
    ['qualification', (input: PolicyFixture) => { input.qualification.rights = 'inferred'; }],
  ] as const)('rejects an unknown field at the %s tier', async (_tier, mutate) => {
    const input = await fixture();
    mutate(input);
    expect(() => parseWechatSourcePolicy(input, fixedNow)).toThrow();
  });

  it.each(['owner', 'publicAudienceEvidence', 'allowedContentScope', 'redistributionBasis'] as const)(
    'rejects blank qualification field %s',
    async (field) => {
      const input = await fixture();
      input.qualification[field] = ' \t ';
      expect(() => parseWechatSourcePolicy(input, fixedNow)).toThrow();
    },
  );

  it('accepts reviewedAt exactly at now and rejects a future reviewedAt', async () => {
    const boundary = await fixture();
    boundary.qualification.reviewedAt = '2026-10-07T13:00:00.000Z';
    expect(parseWechatSourcePolicy(boundary, fixedNow).qualification.reviewedAt).toBe('2026-10-07T13:00:00.000Z');

    const future = await fixture();
    future.qualification.reviewedAt = '2026-10-07T13:00:00.001Z';
    expect(() => parseWechatSourcePolicy(future, fixedNow)).toThrow();
  });

  it('rejects an expired review when reviewUntil equals now or is earlier', async () => {
    for (const reviewUntil of ['2026-10-07T13:00:00.000Z', '2026-10-07T12:59:59.999Z']) {
      const input = await fixture();
      input.qualification.reviewUntil = reviewUntil;
      expect(() => parseWechatSourcePolicy(input, fixedNow)).toThrow();
    }
  });

  it('rejects an interval whose reviewUntil is not later than reviewedAt', async () => {
    const input = await fixture();
    input.qualification.reviewUntil = input.qualification.reviewedAt;
    expect(() => parseWechatSourcePolicy(input, fixedNow)).toThrow();
  });

  it.each([
    '2026-02-30T12:00:00Z',
    '2026-10-06T00:00:00',
    'not-a-timestamp',
    '2026-10-07T13:00:00.0001Z',
  ])('rejects invalid or offset-free timestamp %s', async (reviewedAt) => {
    const input = await fixture();
    input.qualification.reviewedAt = reviewedAt;
    expect(() => parseWechatSourcePolicy(input, fixedNow)).toThrow();
  });

  it('rejects an invalid now clock', async () => {
    const input = await fixture();
    expect(() => parseWechatSourcePolicy(input, new Date(Number.NaN))).toThrow(/valid Date/);
  });
});
