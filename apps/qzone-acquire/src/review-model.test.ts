import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseSocialAcquisitionBundle, socialPublicationBinding, type SocialAcquisitionBundle } from '@nju-info/core';
import { describe, expect, it } from 'vitest';
import { normalizeQzonePost } from './normalize.js';
import {
  applyQzoneReview,
  buildQzoneShadow,
  parseQzoneReviewPolicy,
  qzoneMetadataBytes,
  qzonePolicySha256,
  type QzoneReviewDecisions,
  type QzoneReviewRequest,
  type VerifiedQzoneItem,
} from './review-model.js';

const now = new Date('2026-10-08T08:00:00.000Z');
const reviewNow = new Date('2026-10-08T09:00:00.000Z');
const shadowRunId = '11111111-1111-4111-8111-111111111111';
const reviewRunId = '22222222-2222-4222-8222-222222222222';
const otherRunId = '33333333-3333-4333-8333-333333333333';
const policy = parseQzoneReviewPolicy(JSON.parse(readFileSync(new URL('./fixtures/policy.json', import.meta.url), 'utf8')), now);
const provenance = {
  provider: { name: 'Synthetic acquisition provider', version: 'provider-v1' },
  exporter: { name: 'qzone-acquire', version: 'exporter-v1' },
};
const restrictedMarkers = ['PRIVATE_PROVIDER_BODY', 'PRIVATE_IMAGE_LOCATOR', 'PRIVATE_ACQUISITION_HASH'];
const verified: VerifiedQzoneItem[] = ['CaseSensitiveTid', 'caseSensitiveTid', 'ThirdTid'].map((tid) => ({
  candidate: normalizeQzonePost({
    uin: '10001', tid, created_at: 1791410400,
    content: `${restrictedMarkers[0]} <script>token=private</script>`,
    mediaUrls: [`https://images.example/${restrictedMarkers[1]}.jpg`],
  }),
  acquiredAt: '2026-10-08T07:00:00.000Z',
}));

function shadow(items: VerifiedQzoneItem[] = verified) {
  return buildQzoneShadow(items, policy, {
    schemaVersion: 1,
    items: items.map(({ candidate }, index) => ({ sourceItemId: candidate.sourceItemId, title: index === 1 ? null : `Manual item ${index}` })),
  }, provenance, shadowRunId, now);
}

function declarations(request: QzoneReviewRequest): QzoneReviewDecisions {
  return {
    schemaVersion: 1,
    bundleId: request.bundleId,
    policySha256: request.policySha256,
    reviewer: 'PRIVATE_REVIEWER_DECLARATION',
    reviewedAt: '2026-10-08T16:30:00.000+08:00',
    items: request.items.map((item, index) => ({
      ...structuredClone(item),
      status: (['approved', 'rejected', 'review-required'] as const)[index % 3]!,
      reason: `PRIVATE_REVIEW_REASON_${index}`,
    })),
  };
}

function rebind(bundle: SocialAcquisitionBundle): void {
  for (const envelope of bundle.envelopes) envelope.decision.binding = socialPublicationBinding(envelope.payload);
}

function apply(bundle: SocialAcquisitionBundle, request: QzoneReviewRequest, decisions = declarations(request), currentPolicy = policy) {
  return applyQzoneReview(bundle, request, decisions, currentPolicy, reviewRunId, reviewNow);
}

function retargetRequest(bundle: SocialAcquisitionBundle, request: QzoneReviewRequest): QzoneReviewRequest {
  return { ...request, items: bundle.envelopes.map(({ payload, decision }) => ({ sourceItemId: payload.item.sourceItemId, binding: decision.binding })) };
}

describe('QZone offline reviewed policy', () => {
  it.each(['relay', 'sentinel'] as const)('accepts only current public review-only %s policies', (role) => {
    const input = { ...policy, source: { ...policy.source, role } };
    expect(parseQzoneReviewPolicy(input, now)).toEqual(input);
    const result = buildQzoneShadow(verified.slice(0, 1), input, {
      schemaVersion: 1, items: [{ sourceItemId: verified[0]!.candidate.sourceItemId, title: null }],
    }, provenance, shadowRunId, now);
    expect(result.bundle.envelopes[0]!.payload.source.role).toBe(role);
    expect(apply(result.bundle, result.request, declarations(result.request), input).bundle.envelopes[0]!.decision.mode).toBe('link-only');
  });

  it.each([
    { role: 'official' }, { redistributionMode: 'full' }, { redistributionMode: 'summary' },
    { redistributionMode: 'link-only' }, { redistributionMode: 'denied' }, { access: 'anonymous' },
    { audience: 'friends' }, { displayName: ' \t' }, { policyVersion: ' \t' },
    { platform: 'wechat' }, { token: 'PRIVATE_POLICY_TOKEN' },
  ])('rejects out-of-slice policy %j', (change) => {
    expect(() => parseQzoneReviewPolicy({ ...policy, source: { ...policy.source, ...change } }, now)).toThrow();
  });

  it.each([
    { reviewedAt: '2026-10-09T00:00:00Z' },
    { reviewUntil: '2026-10-08T08:00:00.000Z' },
    { reviewUntil: '2025-01-01T00:00:00Z' },
    { reviewedAt: '2026-10-07T12:00:00' },
    { reviewedAt: '2026-02-30T00:00:00Z' },
    { reviewedAt: '2026-01-01T00:00:00.0001Z' },
    { reviewUntil: '9999-01-01T00:00:00.0000Z' },
    { reviewedAt: 'not-a-time' },
    { owner: ' ' }, { publicAudienceEvidence: ' ' }, { allowedContentScope: ' ' }, { redistributionBasis: ' ' },
  ])('rejects invalid, future, expired or blank qualification %j', (change) => {
    expect(() => parseQzoneReviewPolicy({ ...policy, qualification: { ...policy.qualification, ...change } }, now)).toThrow();
  });

  it('canonicalizes schema order and qualification trimming before hashing the complete policy', () => {
    const reordered = {
      qualification: { ...policy.qualification, owner: ` ${policy.qualification.owner} ` },
      source: Object.fromEntries(Object.entries(policy.source).reverse()),
      schemaVersion: 1,
    };
    const parsed = parseQzoneReviewPolicy(reordered, now);
    expect(qzonePolicySha256(parsed)).toBe(qzonePolicySha256(policy));
    expect(qzonePolicySha256(parsed)).toBe(createHash('sha256').update(JSON.stringify(parsed), 'utf8').digest('hex'));
    const changed = { ...policy, qualification: { ...policy.qualification, redistributionBasis: 'Changed private rights evidence' } };
    expect(qzonePolicySha256(changed)).not.toBe(qzonePolicySha256(policy));
  });

  it('rejects invalid clocks rather than letting NaN pass qualification comparisons', () => {
    expect(() => parseQzoneReviewPolicy(policy, new Date(NaN))).toThrow('clock');
    expect(() => shadow(verified.map((item) => ({ ...item, acquiredAt: '2026-10-08T07:00:00.0001Z' })))).toThrow();
    expect(() => buildQzoneShadow(verified, policy, { schemaVersion: 1, items: [] }, provenance, shadowRunId, new Date(NaN))).toThrow('clock');
    const { bundle, request } = shadow();
    expect(() => applyQzoneReview(bundle, request, declarations(request), policy, reviewRunId, new Date(NaN))).toThrow('clock');
  });
});

describe('QZone sanitized item shadows', () => {
  it('preserves operator selection order, native identity, nullable/manual titles and publication time', () => {
    const selection = {
      schemaVersion: 1,
      items: [
        { sourceItemId: verified[1]!.candidate.sourceItemId, title: null },
        { sourceItemId: verified[0]!.candidate.sourceItemId, title: '  Operator-authored title  ' },
      ],
    };
    const { bundle, metadataBlobs, request } = buildQzoneShadow(verified, policy, selection, provenance, shadowRunId, now);
    expect(bundle.bundleId).toBe(`qzone-shadow-v1:${shadowRunId}`);
    expect(bundle.envelopes.map(({ payload }) => payload.item.sourceItemId)).toEqual(selection.items.map((item) => item.sourceItemId));
    expect(bundle.envelopes.map(({ payload }) => payload.content.title)).toEqual([null, '  Operator-authored title  ']);
    expect(verified[0]!.candidate.sourceItemId).not.toBe(verified[1]!.candidate.sourceItemId);
    bundle.envelopes.forEach(({ payload, decision, provenance: actual }, index) => {
      const original = verified[index === 0 ? 1 : 0]!;
      expect(payload.item.nativeIdentity).toEqual(original.candidate.nativeIdentity);
      expect(payload.item.originalUrl).toBe(original.candidate.originalUrl);
      expect(payload.item.canonicalUrl).toBe(original.candidate.originalUrl);
      expect(payload.publicationTime).toEqual(original.candidate.publicationTime);
      expect(payload.attribution).toEqual({ relationship: 'unknown', verification: 'unknown', origin: null, evidence: [] });
      expect(actual).toEqual({ ...provenance, acquiredAt: original.acquiredAt, method: 'credentialed-public-export', runId: shadowRunId });
      expect(decision).toMatchObject({ status: 'review-required', mode: 'none', method: 'item-review', policyVersion: policy.source.policyVersion, decidedAt: now.toISOString() });
      expect(request.items[index]!.binding).toEqual(socialPublicationBinding(payload));
      expect(metadataBlobs[index]!.bytes).toEqual(qzoneMetadataBytes(payload));
    });
    expect(request).toMatchObject({ schemaVersion: 1, bundleId: bundle.bundleId, policySha256: qzonePolicySha256(policy), preparedAt: now.toISOString() });
  });

  it('emits exactly canonical link metadata with one LF and freshly hashed public-safe descriptors', () => {
    const hostile = structuredClone(verified);
    Object.assign(hostile[0]!.candidate, { rawEvidence: { sha256: restrictedMarkers[2], path: '/private/provider', byteLength: 999999 }, comments: 'PRIVATE_COMMENTS', viewer: 'PRIVATE_VIEWER' });
    const { bundle, metadataBlobs } = shadow(hostile);
    bundle.envelopes.forEach(({ payload }, index) => {
      const output = metadataBlobs[index]!;
      const expected = {
        schemaVersion: 1,
        sanitizationVersion: 'qzone-link-metadata-v1',
        platform: 'qzone',
        publisherIdentity: policy.source.publisherIdentity,
        item: payload.item,
        publicationTime: payload.publicationTime,
        content: payload.content,
        attribution: payload.attribution,
      };
      expect(output.bytes.toString('utf8')).toBe(`${JSON.stringify(expected)}\n`);
      expect(output.sha256).toBe(createHash('sha256').update(output.bytes).digest('hex'));
      expect(payload.rawBlobs).toEqual([{
        blob: { sha256: output.sha256, byteLength: output.bytes.byteLength, contentType: 'application/json; charset=utf-8' },
        sourceUrl: payload.item.canonicalUrl, acquiredAt: hostile[index]!.acquiredAt,
        evidenceTier: 'public-safe', evidenceKind: 'provider-export', sanitizationVersion: 'qzone-link-metadata-v1',
      }]);
      expect(payload.content).toMatchObject({ text: '', html: '', completeness: 'link-only' });
      expect(payload.media).toEqual([]);
      expect(payload.attachments).toEqual([]);
    });
    const publicText = JSON.stringify(bundle) + metadataBlobs.map(({ bytes }) => bytes.toString('utf8')).join('');
    for (const marker of [...restrictedMarkers, 'PRIVATE_COMMENTS', 'PRIVATE_VIEWER', '/private/provider', policy.qualification.owner, policy.qualification.publicAudienceEvidence]) {
      expect(publicText).not.toContain(marker);
    }
    expect(parseSocialAcquisitionBundle(bundle)).toEqual(bundle);
  });

  it('keeps native identities stable across exporter versions and new offline runs', () => {
    const first = shadow();
    const second = buildQzoneShadow(verified, policy, { schemaVersion: 1, items: verified.map(({ candidate }) => ({ sourceItemId: candidate.sourceItemId, title: null })) },
      { ...provenance, exporter: { ...provenance.exporter, version: 'exporter-v2' } }, otherRunId, now);
    expect(second.bundle.envelopes.map(({ payload }) => payload.item.sourceItemId)).toEqual(first.bundle.envelopes.map(({ payload }) => payload.item.sourceItemId));
  });

  it('accepts exactly ten selected items but rejects eleven', () => {
    const items = Array.from({ length: 11 }, (_, index) => ({
      candidate: normalizeQzonePost({ uin: '10001', tid: `Tid${index}`, created_at: 1791410400, content: '', mediaUrls: [] }), acquiredAt: verified[0]!.acquiredAt,
    }));
    expect(shadow(items.slice(0, 10)).bundle.envelopes).toHaveLength(10);
    expect(() => shadow(items)).toThrow('selection');
  });

  it.each([
    { schemaVersion: 1, items: [] },
    { schemaVersion: 2, items: [{ sourceItemId: verified[0]!.candidate.sourceItemId, title: null }] },
    { schemaVersion: 1, items: [{ sourceItemId: verified[0]!.candidate.sourceItemId, title: ' ' }] },
    { schemaVersion: 1, items: [{ sourceItemId: verified[0]!.candidate.sourceItemId }] },
    { schemaVersion: 1, items: [{ sourceItemId: verified[0]!.candidate.sourceItemId, title: 1 }] },
    { schemaVersion: 1, items: [{ sourceItemId: verified[0]!.candidate.sourceItemId, title: null, body: 'PRIVATE_BODY' }] },
    { schemaVersion: 1, items: [{ sourceItemId: `social-native-v1:${'a'.repeat(64)}`, title: null }] },
    { schemaVersion: 1, items: Array.from({ length: 2 }, () => ({ sourceItemId: verified[0]!.candidate.sourceItemId, title: null })) },
    { schemaVersion: 1, items: [{ sourceItemId: verified[0]!.candidate.sourceItemId, title: null }], reviewer: 'PRIVATE_REVIEWER' },
  ])('rejects strict invalid/duplicate/foreign selection %j', (selection) => {
    expect(() => buildQzoneShadow(verified, policy, selection, provenance, shadowRunId, now)).toThrow('selection');
  });

  it('rejects mismatched publisher/native IDs, duplicated acquisition IDs and future detail clocks', () => {
    const changed = structuredClone(verified);
    changed[0]!.candidate.publisherIdentity.value = '20002';
    expect(() => shadow(changed)).toThrow();
    changed[0] = structuredClone(verified[0]!);
    changed[0]!.candidate.nativeIdentity.tid = 'OtherTid';
    expect(() => shadow(changed)).toThrow();
    expect(() => shadow([verified[0]!, verified[0]!])).toThrow();
    expect(() => shadow([{ ...verified[0]!, acquiredAt: '2026-10-08T08:00:00.001Z' }])).toThrow();
    expect(() => shadow([{ ...verified[0]!, acquiredAt: '2026-10-08T07:00:00' }])).toThrow();
  });
});

describe('QZone immutable offline review declarations', () => {
  it('records all three states by item ID without leaking private audit data or altering payloads', () => {
    const { bundle, request, metadataBlobs } = shadow();
    const original = JSON.stringify({ bundle, request });
    const decisions = declarations(request);
    decisions.items.reverse();
    const beforeDecisions = JSON.stringify(decisions);
    const result = apply(bundle, request, decisions);
    expect(result.counts).toEqual({ approved: 1, rejected: 1, reviewRequired: 1 });
    expect(result.bundle.bundleId).toBe(`qzone-review-v1:${reviewRunId}`);
    expect(result.reviewRecord).toEqual(decisions);
    expect(result.bundle.envelopes.map(({ decision }) => [decision.status, decision.mode, decision.method])).toEqual([
      ['approved', 'link-only', 'item-review'], ['rejected', 'none', 'item-review'], ['review-required', 'none', 'item-review'],
    ]);
    result.bundle.envelopes.forEach((envelope, index) => {
      expect(envelope.payload).toEqual(bundle.envelopes[index]!.payload);
      expect(envelope.decision.binding).toEqual(bundle.envelopes[index]!.decision.binding);
      expect(envelope.provenance).toEqual({ ...bundle.envelopes[index]!.provenance, runId: reviewRunId });
      expect(envelope.decision.decidedAt).toBe(decisions.reviewedAt);
      expect(qzoneMetadataBytes(envelope.payload)).toEqual(metadataBlobs[index]!.bytes);
    });
    const publicText = JSON.stringify(result.bundle);
    expect(publicText).not.toContain(decisions.reviewer);
    for (const item of decisions.items) expect(publicText).not.toContain(item.reason);
    expect(JSON.stringify({ bundle, request })).toBe(original);
    expect(JSON.stringify(decisions)).toBe(beforeDecisions);
    expect(parseSocialAcquisitionBundle(result.bundle)).toEqual(result.bundle);
    expect(() => apply(result.bundle, request, decisions)).toThrow();
  });

  it('rejects stale source policy and private qualification changes, even when policyVersion is unchanged', () => {
    const { bundle, request } = shadow();
    const sourceChanges = [{ displayName: 'Changed name' }, { sourceId: 'changed-source' }, { role: 'sentinel' as const }, { policyVersion: 'policy-v2' }];
    for (const change of sourceChanges) expect(() => apply(bundle, request, declarations(request), { ...policy, source: { ...policy.source, ...change } })).toThrow();
    for (const key of ['owner', 'publicAudienceEvidence', 'allowedContentScope', 'redistributionBasis', 'reviewedAt', 'reviewUntil'] as const) {
      const qualification = { ...policy.qualification, [key]: key === 'reviewedAt' ? '2026-01-02T00:00:00Z' : key === 'reviewUntil' ? '9998-01-01T00:00:00Z' : 'Changed qualification' };
      expect(() => apply(bundle, request, declarations(request), { ...policy, qualification })).toThrow();
    }
    const expired = { ...policy, qualification: { ...policy.qualification, reviewUntil: reviewNow.toISOString() } };
    expect(() => apply(bundle, request, declarations(request), expired)).toThrow();
  });

  it('rejects an old payload hash even after a title edit is sanitized and the bundle is correctly rebound', () => {
    const { bundle, request } = shadow();
    const staleDecisions = declarations(request);
    const payload = bundle.envelopes[0]!.payload;
    payload.content.title = 'Revised operator title';
    const bytes = qzoneMetadataBytes(payload);
    payload.rawBlobs[0]!.blob.sha256 = createHash('sha256').update(bytes).digest('hex');
    payload.rawBlobs[0]!.blob.byteLength = bytes.byteLength;
    rebind(bundle);
    expect(() => apply(bundle, request, staleDecisions)).toThrow('binding');
    const newRequest = retargetRequest(bundle, request);
    expect(() => apply(bundle, newRequest, staleDecisions)).toThrow('binding');
  });

  it.each(['sha256', 'byteLength', 'contentType', 'sourceUrl', 'acquiredAt', 'sanitizationVersion', 'evidenceKind'] as const)(
    'rejects forged metadata descriptor %s even with matching core payload bindings', (field) => {
      const { bundle, request } = shadow();
      const raw = bundle.envelopes[0]!.payload.rawBlobs[0]!;
      if (field === 'sha256') raw.blob.sha256 = 'a'.repeat(64);
      else if (field === 'byteLength') raw.blob.byteLength += 1;
      else if (field === 'contentType') raw.blob.contentType = 'text/plain';
      else if (field === 'sourceUrl') raw.sourceUrl = 'https://public.example/other';
      else if (field === 'acquiredAt') raw.acquiredAt = '2026-10-08T06:00:00.000Z';
      else if (field === 'sanitizationVersion') raw.sanitizationVersion = 'unreviewed-v2';
      else raw.evidenceKind = 'origin-response';
      rebind(bundle);
      expect(() => apply(bundle, retargetRequest(bundle, request))).toThrow('descriptor');
    },
  );

  it('rejects aliases, invented attribution, extra blobs and nonpending declarations', () => {
    const cases: Array<(bundle: SocialAcquisitionBundle) => void> = [
      (bundle) => { bundle.envelopes[0]!.payload.item.aliases.push('https://public.example/alias'); },
      (bundle) => { bundle.envelopes[0]!.payload.attribution.relationship = 'relay'; },
      (bundle) => { bundle.envelopes[0]!.payload.rawBlobs.push(structuredClone(bundle.envelopes[0]!.payload.rawBlobs[0]!)); },
      (bundle) => { bundle.envelopes[0]!.decision.status = 'rejected'; },
      (bundle) => { bundle.envelopes[0]!.decision.method = 'source-policy'; },
      (bundle) => { bundle.envelopes[0]!.provenance.method = 'manual-public-capture'; },
    ];
    for (const change of cases) {
      const { bundle, request } = shadow();
      change(bundle);
      rebind(bundle);
      expect(() => apply(bundle, retargetRequest(bundle, request))).toThrow();
    }
    const { bundle, request } = shadow();
    bundle.envelopes[0]!.payload.content.text = 'PRIVATE_BODY';
    expect(() => apply(bundle, request)).toThrow();
  });

  it.each(['request', 'decisions'] as const)('requires exact strict %s coverage and bindings', (kind) => {
    const mutations: Array<(input: QzoneReviewRequest | QzoneReviewDecisions) => void> = [
      (input) => { input.items.pop(); },
      (input) => { input.items = []; },
      (input) => { input.items[1] = structuredClone(input.items[0]!); },
      (input) => { input.items[0]!.sourceItemId = `social-native-v1:${'a'.repeat(64)}`; },
      (input) => { input.items[0]!.binding.payloadSha256 = 'a'.repeat(64); },
      (input) => { input.items[0]!.binding.mediaSha256s = ['a'.repeat(64)]; },
      (input) => { input.bundleId = `qzone-shadow-v1:${otherRunId}`; },
      (input) => { input.policySha256 = 'a'.repeat(64); },
      (input) => { Object.assign(input, { token: 'PRIVATE_UNEXPECTED' }); },
      (input) => { Object.assign(input.items[0]!, { unknown: 'PRIVATE_UNEXPECTED' }); },
      (input) => { Object.assign(input.items[0]!.binding, { unknown: 'PRIVATE_UNEXPECTED' }); },
    ];
    for (const mutate of mutations) {
      const { bundle, request } = shadow();
      const decisions = declarations(request);
      mutate(kind === 'request' ? request : decisions);
      expect(() => apply(bundle, request, decisions)).toThrow();
    }
  });

  it.each([
    '2026-10-08T07:59:59.999Z', '2026-10-08T09:00:00.001Z',
    '2026-10-08T08:30:00', '2026-02-30T08:30:00Z', '2026-10-08T08:30:00.0001Z', 'not-a-time',
  ])('rejects invalid, predating or future declared reviewedAt %s', (reviewedAt) => {
    const { bundle, request } = shadow();
    expect(() => apply(bundle, request, { ...declarations(request), reviewedAt })).toThrow();
  });

  it('accepts exact timestamp boundaries and preserves an explicit offset declaration', () => {
    const { bundle, request } = shadow();
    for (const reviewedAt of [request.preparedAt, reviewNow.toISOString(), '2026-10-08T17:00:00+08:00']) {
      const result = apply(bundle, request, { ...declarations(request), reviewedAt });
      expect(result.bundle.envelopes[0]!.decision.decidedAt).toBe(reviewedAt);
      expect(result.reviewRecord.reviewedAt).toBe(reviewedAt);
    }
  });

  it('rejects invalid/future preparation, blank private audit declarations and unknown statuses without echoing secrets', () => {
    const { bundle, request } = shadow();
    for (const preparedAt of ['2026-10-08T10:00:00Z', '2026-10-08T08:00:00.0001Z', '2026-10-08T08:00:00']) {
      expect(() => apply(bundle, { ...request, preparedAt })).toThrow();
    }
    const invalid = [
      { ...declarations(request), reviewer: ' ' },
      { ...declarations(request), items: declarations(request).items.map((item) => ({ ...item, reason: ' ' })) },
      { ...declarations(request), items: declarations(request).items.map((item) => ({ ...item, status: 'PRIVATE_INVALID_STATUS' })) },
    ];
    for (const decisions of invalid) {
      try {
        applyQzoneReview(bundle, request, decisions, policy, reviewRunId, reviewNow);
        expect.fail('Invalid audit declaration accepted');
      } catch (error) {
        expect(String(error)).toContain('Invalid QZone review decisions');
        expect(String(error)).not.toContain('PRIVATE_INVALID_STATUS');
        expect(String(error)).not.toContain('PRIVATE_REVIEWER_DECLARATION');
      }
    }
  });
});
