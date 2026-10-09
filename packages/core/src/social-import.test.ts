import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseSignedSocialImportOperation, parseSocialImportOperation, parseSocialImportTrust, socialImportOperationBytes,
  socialProducerReceiptBytes, socialPublicationBinding, socialSourceItemId,
  socialTrustedSourceSha256, verifySocialImport,
  type SocialAcquisitionBundle, type SocialEnvelopePayload, type SocialImportInput,
  type SocialImportOperation, type SocialImportTrust, type SocialTrustedSource,
} from './index.js';

// Separate, ephemeral synthetic keys. Outcomes and all clocks/identities are deterministic.
const producer = generateKeyPairSync('ed25519');
const approver = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const now = new Date('2026-10-01T02:00:00.000Z');
const itemClock = '2026-10-01T00:00:00Z';
const acquisitionClock = '2026-10-01T01:00:00Z';
const decisionClock = '2026-10-01T01:10:00Z';
const approvalClock = '2026-10-01T01:30:00Z';
const zeroHash = '0'.repeat(64);

interface Fixture {
  input: SocialImportInput;
  trust: SocialImportTrust;
  source: SocialTrustedSource;
  bundle: SocialAcquisitionBundle;
  operation: SocialImportOperation;
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Independent expected producer encoding, not the production projection implementation. */
function projection(payload: SocialEnvelopePayload): Buffer {
  const fields = {
    schemaVersion: 1,
    sanitizationVersion: payload.source.platform === 'qzone' ? 'qzone-link-metadata-v1' : 'wechat-weread-link-metadata-v1',
    platform: payload.source.platform,
    publisherIdentity: payload.source.publisherIdentity,
    item: payload.item,
    publicationTime: payload.publicationTime,
    content: payload.content,
  };
  return Buffer.from(`${JSON.stringify(payload.source.platform === 'qzone' ? { ...fields, attribution: payload.attribution } : fields)}\n`);
}

function authorize(fixture: Fixture): void {
  fixture.input.authorization = {
    operation: fixture.operation,
    signature: sign(null, socialImportOperationBytes(fixture.operation), approver.privateKey).toString('base64'),
  };
}

/** Re-sign changed transport, so negative byte/policy tests cannot pass merely due to stale signatures. */
function seal(fixture: Fixture, rebuildMetadata = true): void {
  if (rebuildMetadata) {
    const blobs = new Map<string, Buffer>();
    for (const envelope of fixture.bundle.envelopes) {
      const bytes = projection(envelope.payload);
      const raw = envelope.payload.rawBlobs[0]!;
      raw.blob = { sha256: digest(bytes), contentType: 'application/json; charset=utf-8', byteLength: bytes.length };
      blobs.set(raw.blob.sha256, bytes);
    }
    fixture.input.blobs = blobs;
  }
  for (const envelope of fixture.bundle.envelopes) {
    // Fixtures use core schema field order; malformed payload tests deliberately leave invalid structure intact.
    envelope.decision.binding = { payloadSha256: digest(JSON.stringify(envelope.payload)), mediaSha256s: [] };
  }
  fixture.input.bundleBytes = Buffer.from(`${JSON.stringify(fixture.bundle)}\n`);
  const sha256 = digest(fixture.input.bundleBytes);
  fixture.operation.bundle = {
    sha256, producerId: 'synthetic-producer',
    signature: sign(null, socialProducerReceiptBytes('synthetic-producer', sha256), producer.privateKey).toString('base64'),
  };
  fixture.operation.policySha256 = socialTrustedSourceSha256(fixture.source);
  authorize(fixture);
}

function fixture(platform: 'qzone' | 'wechat' = 'qzone'): Fixture {
  const policy: SocialEnvelopePayload['source'] = {
    sourceId: `synthetic-${platform}`, platform,
    publisherIdentity: platform === 'qzone'
      ? { scheme: 'qzone-uin', version: 1, value: '123456789' }
      : { scheme: 'wechat-biz', version: 1, value: Buffer.from('synthetic-publisher').toString('base64') },
    displayName: 'Synthetic public relay', role: 'relay', access: 'credentialed-public',
    audience: 'public', redistributionMode: 'review-only', policyVersion: 'policy-1',
  };
  const source: SocialTrustedSource = {
    policy: structuredClone(policy), organization: { id: 'synthetic-org', name: 'Synthetic organization' },
    homepageUrl: 'https://public.example/',
    qualification: {
      owner: 'Synthetic operator', publicAudienceEvidence: 'Synthetic general-public audience evidence',
      allowedContentScope: 'link-only', redistributionBasis: 'Synthetic link metadata qualification',
      reviewedAt: '2026-09-30T00:00:00Z', reviewUntil: '2026-11-01T00:00:00Z',
    },
    producerIds: ['synthetic-producer'], approverIds: ['synthetic-approver'],
  };
  const nativeIdentity: SocialEnvelopePayload['item']['nativeIdentity'] = platform === 'qzone'
    ? { scheme: 'qzone-tid', version: 1, tid: 'synthetic-post-1' }
    : { scheme: 'wechat-mid-idx', version: 1, mid: '1001', idx: 1 };
  const payload: SocialEnvelopePayload = {
    source: policy,
    item: {
      nativeIdentity,
      sourceItemId: socialSourceItemId({ platform, publisher: policy.publisherIdentity, item: nativeIdentity }),
      originalUrl: 'https://public.example/posts/1', canonicalUrl: 'https://public.example/posts/1', aliases: [],
    },
    publicationTime: {
      original: { value: itemClock, representation: 'iso8601' }, precision: 'second', timezone: 'UTC',
      normalizedAt: itemClock, publishedOn: '2026-10-01',
    },
    content: { title: 'Synthetic metadata title', text: '', html: '', completeness: 'link-only' },
    media: [], attachments: [],
    attribution: { relationship: 'unknown', verification: 'unknown', origin: null, evidence: [] },
    rawBlobs: [{
      blob: { sha256: zeroHash, byteLength: 0, contentType: 'application/json; charset=utf-8' },
      sourceUrl: 'https://public.example/posts/1', acquiredAt: acquisitionClock,
      evidenceTier: 'public-safe', evidenceKind: 'provider-export',
      sanitizationVersion: platform === 'qzone' ? 'qzone-link-metadata-v1' : 'wechat-weread-link-metadata-v1',
    }],
  };
  const bundle: SocialAcquisitionBundle = {
    schemaVersion: 1, bundleId: 'synthetic-bundle', envelopes: [{
      schemaVersion: 1, payload,
      provenance: {
        acquiredAt: acquisitionClock, method: 'credentialed-public-export',
        provider: { name: 'synthetic-provider', version: '1' }, exporter: { name: 'synthetic-exporter', version: '1' }, runId: 'synthetic-run',
      },
      decision: {
        status: 'review-required', mode: 'none', method: 'item-review', policyVersion: policy.policyVersion,
        decidedAt: decisionClock, reason: 'Synthetic pending declaration is not publication authority',
        binding: socialPublicationBinding(payload),
      },
    }],
  };
  const trust: SocialImportTrust = {
    schemaVersion: 1,
    producers: [{ id: 'synthetic-producer', publicKey: producer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }],
    approvers: [{ id: 'synthetic-approver', publicKey: approver.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }],
    sources: [source],
  };
  const operation: SocialImportOperation = {
    schemaVersion: 1, operationId: '38cdb7f3-5727-40c4-a198-3ddcb273bd95', sourceId: policy.sourceId,
    sequence: 1, issuedAt: approvalClock, expiresAt: '2026-10-02T00:00:00Z', policySha256: zeroHash,
    approverId: 'synthetic-approver', action: 'publish',
    bundle: { sha256: zeroHash, producerId: 'synthetic-producer', signature: Buffer.alloc(64).toString('base64') },
    sourceItemIds: [], reasonCode: 'approved-metadata',
  };
  const result: Fixture = { trust, source, bundle, operation, input: { trust, authorization: null, bundleBytes: null, blobs: new Map() } };
  seal(result);
  return result;
}

function control(action: 'suppress' | 'revoke-source'): Fixture {
  const result = fixture();
  result.operation.action = action;
  result.operation.bundle = null;
  result.operation.sourceItemIds = action === 'suppress' ? [result.bundle.envelopes[0]!.payload.item.sourceItemId] : [];
  result.operation.reasonCode = action === 'suppress' ? 'withdrawal' : 'source-revocation';
  result.input.bundleBytes = null;
  result.input.blobs = new Map();
  authorize(result);
  return result;
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)]));
  }
  return value;
}

describe('authenticated social metadata import', () => {
  it.each(['qzone', 'wechat'] as const)('qualifies actual %s metadata signatures without promoting producer flags', (platform) => {
    const data = fixture(platform);
    const verified = verifySocialImport(data.input, now);
    expect(verified.bundle).toEqual(data.bundle);
    expect(verified.bundle?.envelopes[0]?.decision.status).toBe('review-required');
    expect(verified.source.policy.role).toBe('relay');
    expect(verified.bundle?.envelopes[0]?.payload.attribution.relationship).toBe('unknown');
    expect(verified.bundleBytes?.equals(data.input.bundleBytes!)).toBe(true);
    expect(verified.blobs).toEqual(data.input.blobs);
    expect(verified.authorizationBytes.toString()).toBe(`${JSON.stringify(parseSignedSocialImportOperation(data.input.authorization))}\n`);
    expect(verified.operationSha256).toBe(digest(socialImportOperationBytes(data.operation)));
  });

  it.each(['publish', 'restore'] as const)('accepts independently authorized %s with approved producer declarations', (action) => {
    const data = fixture();
    data.operation.action = action;
    data.bundle.envelopes[0]!.decision.status = 'approved';
    data.bundle.envelopes[0]!.decision.mode = 'link-only';
    seal(data);
    expect(verifySocialImport(data.input, now).operation.action).toBe(action);
  });

  it.each(['suppress', 'revoke-source'] as const)('authenticates %s controls under denied policy without producer data', (action) => {
    const data = control(action);
    data.source.policy.redistributionMode = 'denied';
    data.operation.policySha256 = socialTrustedSourceSha256(data.source);
    authorize(data);
    expect(verifySocialImport(data.input, now).bundle).toBeNull();
    expect(verifySocialImport(data.input, now).blobs.size).toBe(0);
  });

  it('uses exact schema signing order independent of nested transport property order', () => {
    const data = fixture();
    const receipt = data.operation.bundle!;
    expect(socialProducerReceiptBytes(receipt.producerId, receipt.sha256).toString()).toBe(
      JSON.stringify(['social-producer-bundle', 1, 'synthetic-producer', receipt.sha256]),
    );
    const orderedOperation = {
      schemaVersion: 1, operationId: data.operation.operationId, sourceId: data.operation.sourceId,
      sequence: 1, issuedAt: approvalClock, expiresAt: data.operation.expiresAt,
      policySha256: data.operation.policySha256, approverId: 'synthetic-approver', action: 'publish',
      bundle: { sha256: receipt.sha256, producerId: receipt.producerId, signature: receipt.signature },
      sourceItemIds: [], reasonCode: 'approved-metadata',
    };
    expect(socialImportOperationBytes(reverseKeys(data.operation)).toString()).toBe(JSON.stringify(['social-import-operation', 1, orderedOperation]));
    expect(socialTrustedSourceSha256(reverseKeys(data.source) as SocialTrustedSource)).toBe(digest(JSON.stringify(data.source)));
    data.input.trust = reverseKeys(data.trust);
    data.input.authorization = reverseKeys(data.input.authorization);
    expect(verifySocialImport(data.input, now).operation).toEqual(data.operation);
  });

  it('denies all with valid empty trust', () => {
    const data = fixture();
    data.input.trust = { schemaVersion: 1, producers: [], approvers: [], sources: [] };
    expect(parseSocialImportTrust(data.input.trust).sources).toEqual([]);
    expect(() => verifySocialImport(data.input, now)).toThrow('Untrusted social source');
  });

  it.each(['operator', 'producer'] as const)('rejects wrong %s keys even with the configured signer string', (role) => {
    const data = fixture();
    if (role === 'operator') {
      data.input.authorization = { operation: data.operation, signature: sign(null, socialImportOperationBytes(data.operation), stranger.privateKey).toString('base64') };
    } else {
      data.operation.bundle!.signature = sign(null, socialProducerReceiptBytes('synthetic-producer', data.operation.bundle!.sha256), stranger.privateKey).toString('base64');
      authorize(data);
    }
    expect(() => verifySocialImport(data.input, now)).toThrow(`Invalid social ${role} signature`);
  });

  it.each(['publish', 'restore'] as const)('never revives a rejected producer packet through %s authorization', (action) => {
    const data = fixture();
    data.operation.action = action;
    data.bundle.envelopes[0]!.decision.status = 'rejected';
    seal(data);
    expect(() => verifySocialImport(data.input, now)).toThrow('Rejected producer packet');
  });

  it('rejects altered bundle bytes before parsing', () => {
    const data = fixture();
    data.input.bundleBytes = Buffer.concat([data.input.bundleBytes!, Buffer.from(' ')]);
    expect(() => verifySocialImport(data.input, now)).toThrow('bundle hash mismatch');
  });

  it('rejects malformed UTF8 even with authentic exact bundle receipt', () => {
    const data = fixture();
    data.input.bundleBytes = Buffer.from([0xff]);
    data.operation.bundle!.sha256 = digest(data.input.bundleBytes);
    data.operation.bundle!.signature = sign(null, socialProducerReceiptBytes('synthetic-producer', data.operation.bundle!.sha256), producer.privateKey).toString('base64');
    authorize(data);
    expect(() => verifySocialImport(data.input, now)).toThrow();
  });

  it.each(['missing', 'surplus', 'altered', 'mime', 'length', 'replaced', 'restricted', 'pretty', 'no-lf'] as const)(
    'rejects %s blob transport even when producer and operator authorize its bundle', (caseName) => {
      const data = fixture();
      const raw = data.bundle.envelopes[0]!.payload.rawBlobs[0]!;
      const bytes = data.input.blobs.get(raw.blob.sha256)!;
      if (caseName === 'missing') data.input.blobs = new Map();
      if (caseName === 'surplus') data.input.blobs = new Map([...data.input.blobs, [zeroHash, Buffer.from('surplus')]]);
      if (caseName === 'altered') data.input.blobs = new Map([[raw.blob.sha256, Buffer.from('different')]]);
      if (caseName === 'mime') raw.blob.contentType = 'text/html';
      if (caseName === 'length') raw.blob.byteLength++;
      if (['replaced', 'restricted', 'pretty', 'no-lf'].includes(caseName)) {
        const replacement = caseName === 'replaced' ? Buffer.from('{}\n')
          : caseName === 'restricted' ? Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), cookies: 'synthetic-secret' }) + '\n')
          : caseName === 'pretty' ? Buffer.from(JSON.stringify(JSON.parse(bytes.toString()), null, 2) + '\n')
          : bytes.subarray(0, bytes.length - 1);
        raw.blob.sha256 = digest(replacement);
        raw.blob.byteLength = replacement.length;
        data.input.blobs = new Map([[raw.blob.sha256, replacement]]);
      }
      seal(data, false);
      expect(() => verifySocialImport(data.input, now)).toThrow();
    },
  );

  it.each(['organization', 'owner', 'homepage', 'allowlist', 'policy'] as const)('binds complete %s registration, not just policyVersion', (field) => {
    const data = fixture();
    if (field === 'organization') data.source.organization.name = 'Other organization';
    if (field === 'owner') data.source.qualification.owner = 'Other owner';
    if (field === 'homepage') data.source.homepageUrl = 'https://other.example/';
    if (field === 'allowlist') {
      data.trust.producers.push({ id: 'other-producer', publicKey: stranger.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
      data.source.producerIds.push('other-producer');
    }
    if (field === 'policy') data.source.policy.displayName = 'Changed display';
    expect(() => verifySocialImport(data.input, now)).toThrow('policy fingerprint mismatch');
  });

  it.each(['future-approval', 'expired-approval', 'future-review', 'expired-review', 'review-after-approval'] as const)('rejects %s by epoch', (caseName) => {
    const data = fixture();
    if (caseName === 'future-approval') data.operation.issuedAt = '2026-10-01T02:00:00.001Z';
    if (caseName === 'expired-approval') data.operation.expiresAt = now.toISOString();
    if (caseName === 'future-review') data.source.qualification.reviewedAt = '2026-10-01T02:00:00.001Z';
    if (caseName === 'expired-review') data.source.qualification.reviewUntil = now.toISOString();
    if (caseName === 'review-after-approval') data.source.qualification.reviewedAt = '2026-10-01T01:30:00.001Z';
    seal(data);
    expect(() => verifySocialImport(data.input, now)).toThrow('not currently valid');
  });

  it('compares offset clocks by instant rather than lexical representation', () => {
    const data = fixture();
    data.source.qualification.reviewedAt = '2026-10-01T08:00:00+08:00';
    data.operation.issuedAt = '2026-10-01T09:30:00+08:00';
    data.operation.expiresAt = '2026-10-01T11:00:00+08:00';
    seal(data);
    expect(verifySocialImport(data.input, now).operation.issuedAt).toBe(data.operation.issuedAt);
  });

  it.each(['issuedAt', 'expiresAt', 'reviewedAt', 'reviewUntil', 'raw', 'provenance', 'decision', 'publication'] as const)(
    'rejects submillisecond %s clocks rather than truncating', (field) => {
      const data = fixture();
      const value = '2026-10-01T01:00:00.0001Z';
      const envelope = data.bundle.envelopes[0]!;
      if (field === 'issuedAt' || field === 'expiresAt') {
        data.operation[field] = value;
        expect(() => socialImportOperationBytes(data.operation)).toThrow();
        return;
      }
      if (field === 'reviewedAt' || field === 'reviewUntil') {
        data.source.qualification[field] = value;
        expect(() => parseSocialImportTrust(data.trust)).toThrow();
        return;
      }
      if (field === 'raw') envelope.payload.rawBlobs[0]!.acquiredAt = value;
      if (field === 'provenance') envelope.provenance.acquiredAt = value;
      if (field === 'decision') envelope.decision.decidedAt = value;
      if (field === 'publication') envelope.payload.publicationTime.normalizedAt = value;
      seal(data);
      expect(() => verifySocialImport(data.input, now)).toThrow();
    },
  );

  it.each(['raw-clock', 'decision-before-acquisition', 'decision-after-approval', 'future-publication'] as const)('rejects %s order', (field) => {
    const data = fixture();
    const envelope = data.bundle.envelopes[0]!;
    if (field === 'raw-clock') envelope.payload.rawBlobs[0]!.acquiredAt = decisionClock;
    if (field === 'decision-before-acquisition') envelope.decision.decidedAt = itemClock;
    if (field === 'decision-after-approval') envelope.decision.decidedAt = now.toISOString();
    if (field === 'future-publication') {
      envelope.payload.publicationTime.original = { value: '2026-10-01T01:00:01Z', representation: 'iso8601' };
      envelope.payload.publicationTime.normalizedAt = null;
    }
    seal(data);
    expect(() => verifySocialImport(data.input, now)).toThrow();
  });

  it.each(['day', 'minute', 'millisecond', 'unknown'] as const)('preserves native %s precision without inferred times', (precision) => {
    const data = fixture('wechat');
    const time = data.bundle.envelopes[0]!.payload.publicationTime;
    if (precision === 'unknown') Object.assign(time, { original: null, precision, normalizedAt: null, publishedOn: null, timezone: null });
    if (precision === 'day') Object.assign(time, { original: { value: '2026-10-01', representation: 'iso8601' }, precision, normalizedAt: null });
    if (precision === 'minute') Object.assign(time, { original: { value: '2026-10-01T00:00Z', representation: 'iso8601' }, precision });
    if (precision === 'millisecond') Object.assign(time, { original: { value: '2026-10-01T00:00:00.001Z', representation: 'iso8601' }, precision, normalizedAt: '2026-10-01T00:00:00.001Z' });
    seal(data);
    expect(verifySocialImport(data.input, now).bundle?.envelopes[0]?.payload.publicationTime).toEqual(time);
  });

  it.each(['full', 'body', 'media', 'blank-title', 'aliases', 'url', 'version', 'source', 'publisher', 'identity', 'attribution', 'item-review', 'denied', 'raw-count'] as const)(
    'rejects unsupported or unbound %s even with authentic transport', (field) => {
      const data = fixture();
      const envelope = data.bundle.envelopes[0]!;
      const payload = envelope.payload;
      if (field === 'full') payload.content.completeness = 'full';
      if (field === 'body') payload.content.text = 'Restricted body';
      if (field === 'media') payload.media.push({ position: 0, kind: 'image', title: 'Restricted image', originalUrl: null, acquisitionStatus: 'not-requested', blob: null });
      if (field === 'blank-title') payload.content.title = '   ';
      if (field === 'aliases') payload.item.aliases.push('https://public.example/alias');
      if (field === 'url') payload.item.canonicalUrl = 'https://public.example/?token=synthetic';
      if (field === 'version') payload.rawBlobs[0]!.sanitizationVersion = 'unknown-v2';
      if (field === 'source') payload.source.displayName = 'Different policy';
      if (field === 'publisher') payload.source.publisherIdentity = { scheme: 'qzone-uin', version: 1, value: '987654321' };
      if (field === 'identity') payload.item.sourceItemId = `social-native-v1:${zeroHash}`;
      if (field === 'attribution') payload.attribution.relationship = 'original';
      if (field === 'item-review') envelope.decision.method = 'source-policy';
      if (field === 'denied') { data.source.policy.redistributionMode = 'denied'; payload.source.redistributionMode = 'denied'; }
      if (field === 'raw-count') payload.rawBlobs.push(structuredClone(payload.rawBlobs[0]!));
      seal(data);
      expect(() => verifySocialImport(data.input, now)).toThrow();
    },
  );

  it('rejects duplicate identities and mixed-source batches as one operation', () => {
    const duplicate = fixture();
    duplicate.bundle.envelopes.push(structuredClone(duplicate.bundle.envelopes[0]!));
    seal(duplicate);
    expect(() => verifySocialImport(duplicate.input, now)).toThrow('Duplicate social native identity');
    const mixed = fixture();
    mixed.bundle.envelopes.push(structuredClone(fixture('wechat').bundle.envelopes[0]!));
    seal(mixed);
    expect(() => verifySocialImport(mixed.input, now)).toThrow('Social source policy mismatch');
  });

  it.each(['reused-key', 'reused-id', 'unknown-role', 'duplicate-source', 'duplicate-publisher', 'private-key', 'wrong-algorithm', 'noncanonical-key'] as const)(
    'rejects %s trust registration', (field) => {
      const data = fixture();
      if (field === 'reused-key') data.trust.approvers[0]!.publicKey = data.trust.producers[0]!.publicKey;
      if (field === 'reused-id') data.trust.approvers[0]!.id = 'synthetic-producer';
      if (field === 'unknown-role') data.source.producerIds = ['synthetic-approver'];
      if (field === 'duplicate-source') data.trust.sources.push(structuredClone(data.source));
      if (field === 'duplicate-publisher') { const second = structuredClone(data.source); second.policy.sourceId = 'other-source'; data.trust.sources.push(second); }
      if (field === 'private-key') data.trust.producers[0]!.publicKey = producer.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
      if (field === 'wrong-algorithm') data.trust.producers[0]!.publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      if (field === 'noncanonical-key') data.trust.producers[0]!.publicKey += '\n';
      expect(() => parseSocialImportTrust(data.trust)).toThrow();
    },
  );

  it.each(['publish-no-bundle', 'restore-ids', 'suppress-no-ids', 'suppress-duplicate', 'revoke-bundle', 'reason', 'sequence', 'signature', 'clock-offset'] as const)(
    'rejects malformed %s operations', (field) => {
      const data = control('suppress');
      const signed = parseSignedSocialImportOperation(data.input.authorization);
      if (field === 'publish-no-bundle') { signed.operation.action = 'publish'; signed.operation.sourceItemIds = []; signed.operation.reasonCode = 'approved-metadata'; }
      if (field === 'restore-ids') { const publishing = fixture(); signed.operation = publishing.operation; signed.operation.action = 'restore'; signed.operation.sourceItemIds = ['social-native-v1:' + zeroHash]; }
      if (field === 'suppress-no-ids') signed.operation.sourceItemIds = [];
      if (field === 'suppress-duplicate') signed.operation.sourceItemIds.push(signed.operation.sourceItemIds[0]!);
      if (field === 'revoke-bundle') { signed.operation = fixture().operation; signed.operation.action = 'revoke-source'; signed.operation.reasonCode = 'source-revocation'; }
      if (field === 'reason') signed.operation.reasonCode = 'approved-metadata';
      if (field === 'sequence') signed.operation.sequence = Number.MAX_SAFE_INTEGER + 1;
      if (field === 'signature') signed.signature = signed.signature.replace(/=+$/, '');
      if (field === 'clock-offset') signed.operation.issuedAt = '2026-10-01T01:30:00';
      expect(() => parseSignedSocialImportOperation(signed)).toThrow();
    },
  );

  it('rejects arbitrary fields across trust, authorization, receipt, envelope and metadata tiers', () => {
    const data = fixture();
    for (const target of [data.trust, data.source, data.source.policy, data.source.organization,
      data.source.qualification, data.trust.producers[0]!, data.trust.approvers[0]!]) {
      Object.assign(target, { cookies: 'synthetic-secret' });
      expect(() => parseSocialImportTrust(data.trust)).toThrow();
      delete (target as unknown as Record<string, unknown>).cookies;
    }
    const signed = parseSignedSocialImportOperation(data.input.authorization);
    for (const target of [signed, signed.operation, signed.operation.bundle!]) {
      Object.assign(target, { privateKey: 'synthetic-secret' });
      expect(() => parseSignedSocialImportOperation(signed)).toThrow();
      delete (target as unknown as Record<string, unknown>).privateKey;
    }
    const envelope = data.bundle.envelopes[0]!;
    for (const target of [envelope, envelope.payload, envelope.payload.item, envelope.payload.item.nativeIdentity,
      envelope.payload.source.publisherIdentity, envelope.payload.publicationTime, envelope.payload.publicationTime.original!,
      envelope.payload.content, envelope.payload.attribution, envelope.payload.rawBlobs[0]!, envelope.payload.rawBlobs[0]!.blob,
      envelope.provenance, envelope.provenance.provider, envelope.provenance.exporter, envelope.decision]) {
      Object.assign(target, { collectorAccountId: 'synthetic-secret' });
      seal(data, false);
      expect(() => verifySocialImport(data.input, now)).toThrow();
      delete (target as unknown as Record<string, unknown>).collectorAccountId;
    }
  });

  it('rejects controls carrying data, denied publication, and invalid verification clocks', () => {
    const data = control('suppress');
    data.input.bundleBytes = Buffer.from('{}');
    expect(() => verifySocialImport(data.input, now)).toThrow('cannot carry bundle data');
    expect(() => verifySocialImport(fixture().input, new Date(NaN))).toThrow('Invalid verification clock');
  });

  it('rejects future day-only publication in its declared timezone without manufacturing an instant', () => {
    const data = fixture('wechat');
    const time = data.bundle.envelopes[0]!.payload.publicationTime;
    Object.assign(time, {
      original: { value: '2026-10-02', representation: 'iso8601' }, precision: 'day', timezone: 'Asia/Shanghai',
      normalizedAt: null, publishedOn: '2026-10-02',
    });
    seal(data);
    expect(() => verifySocialImport(data.input, now)).toThrow('Future social publication day');
  });

  it('parses unsigned operations strictly before signer key access', () => {
    const data = fixture();
    expect(parseSocialImportOperation(reverseKeys(data.operation))).toEqual(data.operation);
    expect(() => parseSocialImportOperation({ ...data.operation, privateKey: 'synthetic-secret' })).toThrow();
  });

  it.each(['suppress', 'revoke-source'] as const)('requires real approver authority for %s controls', (action) => {
    const data = control(action);
    data.input.authorization = { operation: data.operation, signature: sign(null, socialImportOperationBytes(data.operation), producer.privateKey).toString('base64') };
    expect(() => verifySocialImport(data.input, now)).toThrow('Invalid social operator signature');
  });

  it.each(['producer', 'approver'] as const)('rejects known %s keys outside the source allowlist', (role) => {
    const data = fixture();
    const key = { id: `other-${role}`, publicKey: stranger.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    if (role === 'producer') { data.trust.producers.push(key); data.source.producerIds = [key.id]; }
    else { data.trust.approvers.push(key); data.source.approverIds = [key.id]; }
    data.operation.policySha256 = socialTrustedSourceSha256(data.source);
    authorize(data);
    expect(() => verifySocialImport(data.input, now)).toThrow(`Untrusted social ${role}`);
  });

  it.each(['sequence', 'expiresAt', 'sourceId', 'policySha256', 'bundle'] as const)('signature binds altered %s authorization fields', (field) => {
    const data = fixture();
    if (field === 'sequence') data.operation.sequence++;
    if (field === 'expiresAt') data.operation.expiresAt = '2026-10-03T00:00:00Z';
    if (field === 'sourceId') data.operation.sourceId = 'other-source';
    if (field === 'policySha256') data.operation.policySha256 = zeroHash;
    if (field === 'bundle') data.operation.bundle!.sha256 = zeroHash;
    expect(() => verifySocialImport(data.input, now)).toThrow();
  });

  it('accepts exact whitespace-bearing bundle transport only after re-signing its byte hash', () => {
    const data = fixture();
    data.input.bundleBytes = Buffer.from(JSON.stringify(reverseKeys(data.bundle), null, 2) + '\n');
    const sha256 = digest(data.input.bundleBytes);
    data.operation.bundle = { sha256, producerId: 'synthetic-producer', signature: sign(null, socialProducerReceiptBytes('synthetic-producer', sha256), producer.privateKey).toString('base64') };
    authorize(data);
    const verified = verifySocialImport(data.input, now);
    expect(verified.bundle).toEqual(data.bundle);
    expect(verified.bundleBytes).toEqual(data.input.bundleBytes);
  });

  it('supports multiple native items from one source without changing identity for provider versions', () => {
    const data = fixture('wechat');
    const second = structuredClone(data.bundle.envelopes[0]!);
    second.payload.item.nativeIdentity = { scheme: 'wechat-mid-idx', version: 1, mid: '1001', idx: 2 };
    second.payload.item.sourceItemId = socialSourceItemId({ platform: 'wechat', publisher: data.source.policy.publisherIdentity, item: second.payload.item.nativeIdentity });
    second.payload.item.originalUrl = 'https://public.example/posts/2';
    second.payload.item.canonicalUrl = 'https://public.example/posts/2';
    second.payload.rawBlobs[0]!.sourceUrl = 'https://public.example/posts/2';
    data.bundle.envelopes.push(second);
    data.bundle.envelopes[0]!.provenance.provider.version = 'replacement-2';
    seal(data);
    const verified = verifySocialImport(data.input, now);
    expect(verified.bundle?.envelopes.map((envelope) => envelope.payload.item.sourceItemId)).toEqual(data.bundle.envelopes.map((envelope) => envelope.payload.item.sourceItemId));
    expect(verified.blobs.size).toBe(2);
  });

  it('bounds bundle and metadata bytes before decoding or positive projection reconstruction', () => {
    const data = fixture();
    data.input.bundleBytes = Buffer.alloc(16 * 1024 * 1024 + 1);
    expect(() => verifySocialImport(data.input, now)).toThrow('Invalid social bundle size');
    const blobData = fixture();
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const raw = blobData.bundle.envelopes[0]!.payload.rawBlobs[0]!;
    raw.blob.sha256 = digest(bytes);
    raw.blob.byteLength = bytes.length;
    blobData.input.blobs = new Map([[raw.blob.sha256, bytes]]);
    seal(blobData, false);
    expect(() => verifySocialImport(blobData.input, now)).toThrow('Metadata blob descriptor or hash mismatch');
  });

  it('does not mutate trusted input, signed records, payloads, maps or exact byte buffers', () => {
    const data = fixture();
    const trustBefore = JSON.stringify(data.trust);
    const authorizationBefore = JSON.stringify(data.input.authorization);
    const bundleBefore = Buffer.from(data.input.bundleBytes!);
    const blobsBefore = new Map([...data.input.blobs].map(([key, bytes]) => [key, Buffer.from(bytes)]));
    verifySocialImport(data.input, now);
    expect(JSON.stringify(data.trust)).toBe(trustBefore);
    expect(JSON.stringify(data.input.authorization)).toBe(authorizationBefore);
    expect(data.input.bundleBytes).toEqual(bundleBefore);
    expect(data.input.blobs).toEqual(blobsBefore);
    const malformed = fixture();
    malformed.input.blobs = new Map([...malformed.input.blobs, [zeroHash, Buffer.from('surplus')]]);
    const before = JSON.stringify(malformed.input.authorization);
    expect(() => verifySocialImport(malformed.input, now)).toThrow();
    expect(JSON.stringify(malformed.input.authorization)).toBe(before);
    expect(malformed.input.blobs.has(zeroHash)).toBe(true);
  });
  it.each(['content', '\\u0063ontent'])('rejects duplicate %s members hiding restricted bundle bytes', (key) => {
    const data = fixture('wechat');
    const content = data.bundle.envelopes[0]!.payload.content;
    const member = `"content":${JSON.stringify(content)}`;
    const hidden = { ...content, text: 'synthetic-restricted-body', completeness: 'full' };
    data.input.bundleBytes = Buffer.from(JSON.stringify(data.bundle).replace(member, `"${key}":${JSON.stringify(hidden)},${member}`));
    const sha256 = digest(data.input.bundleBytes);
    data.operation.bundle = {
      sha256, producerId: 'synthetic-producer',
      signature: sign(null, socialProducerReceiptBytes('synthetic-producer', sha256), producer.privateKey).toString('base64'),
    };
    authorize(data);
    expect(() => verifySocialImport(data.input, now)).toThrow();
  });

  it.each([
    { value: '2026-10-02', representation: 'iso8601' as const },
    { value: '2026年10月2日', representation: 'text' as const },
  ])('rejects future day original $representation even when publishedOn is null', (original) => {
    const data = fixture('wechat');
    Object.assign(data.bundle.envelopes[0]!.payload.publicationTime, {
      original, precision: 'day', timezone: 'UTC', normalizedAt: null, publishedOn: null,
    });
    seal(data);
    expect(() => verifySocialImport(data.input, now)).toThrow();
  });
});
