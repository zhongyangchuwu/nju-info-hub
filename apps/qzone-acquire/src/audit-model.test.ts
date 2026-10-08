import { socialSourceItemId, type SocialEnvelopePayload } from '@nju-info/core';
import { describe, expect, it } from 'vitest';
import {
  buildQzoneAuditLedger, parseQzoneAuditInputs,
  type AuditRate, type QzoneAcquisitionSummary, type QzoneManualAudit, type QzoneObservations,
} from './audit-model.js';
import type { QzonePolicy } from './config.js';
import { qzonePolicySha256 } from './review-model.js';

const now = new Date('2026-10-08T10:00:00.000Z');
const publisher = { scheme: 'qzone-uin', version: 1, value: '10001' } as const;
const policy: QzonePolicy = {
  schemaVersion: 1,
  source: {
    sourceId: 'qzone-synthetic-relay', platform: 'qzone', publisherIdentity: publisher,
    displayName: 'Synthetic public relay', role: 'relay', access: 'credentialed-public', audience: 'public',
    redistributionMode: 'review-only', policyVersion: 'policy-v1',
  },
  qualification: {
    owner: 'Synthetic operator', publicAudienceEvidence: 'Synthetic audience declaration',
    allowedContentScope: 'Synthetic posts only', redistributionBasis: 'Synthetic review-only declaration',
    reviewedAt: '2026-10-01T00:00:00.000Z', reviewUntil: '2026-11-01T00:00:00.000Z',
  },
};
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const unknownTime: SocialEnvelopePayload['publicationTime'] = {
  original: null, precision: 'unknown', timezone: null, normalizedAt: null, publishedOn: null,
};

function time(value = '2026-10-08T06:30:00Z', precision: 'minute' | 'second' | 'millisecond' = 'second'): SocialEnvelopePayload['publicationTime'] {
  return { original: { value, representation: 'iso8601' }, precision, timezone: 'UTC', normalizedAt: null, publishedOn: '2026-10-08' };
}

function auditItem(tid: string, publicationTime = time(), actionable: 'yes' | 'no' | 'unknown' = 'yes'): QzoneManualAudit['items'][number] {
  return { nativeIdentity: { scheme: 'qzone-tid', version: 1, tid }, publicationTime, actionable };
}

function acquired(tid: string, acquiredAt = '2026-10-08T06:40:00.000Z', publicationTime = time()): QzoneAcquisitionSummary['items'][number] {
  const nativeIdentity = { scheme: 'qzone-tid', version: 1, tid } as const;
  return {
    nativeIdentity, sourceItemId: socialSourceItemId({ platform: 'qzone', publisher, item: nativeIdentity }),
    publicationTime, acquiredAt, contentCompleteness: 'partial',
  };
}

function run(index: number, items: QzoneAcquisitionSummary['items'] = [], startedAt = '2026-10-08T06:39:00.000Z', completedAt = '2026-10-08T06:41:00.000Z'): QzoneAcquisitionSummary {
  const runId = ids[index]!;
  return { inputDir: `/private/synthetic-acquisitions/${runId}`, runId, manifestSha256: String(index + 1).repeat(64), sourceId: policy.source.sourceId, publisherIdentity: publisher, startedAt, completedAt, items };
}

function declarations(items = [auditItem('A')], runs: QzoneAcquisitionSummary[] = []): { audit: QzoneManualAudit; observations: QzoneObservations } {
  return {
    audit: {
      schemaVersion: 1, sourceId: policy.source.sourceId, publisherIdentity: publisher,
      window: { startAt: '2026-10-08T06:00:00.000Z', endAt: '2026-10-08T07:00:00.000Z' },
      observedAt: '2026-10-08T07:01:00.000Z', method: 'manual-public-profile', auditor: 'PRIVATE_AUDITOR',
      publicAudienceEvidence: 'PRIVATE_PUBLIC_AUDIENCE_DECLARATION', coverage: { status: 'complete', reason: 'PRIVATE_COVERAGE_REASON' }, items,
    },
    observations: {
      schemaVersion: 1, sourceId: policy.source.sourceId, publisherIdentity: publisher, captureCutoffAt: '2026-10-08T09:00:00.000Z',
      attempts: runs.map((summary) => ({ outcome: 'success', attemptedAt: summary.startedAt, runDirectory: summary.inputDir })),
    },
  };
}

function ledger(items = [auditItem('A')], runs: QzoneAcquisitionSummary[] = []) {
  const input = declarations(items, runs);
  return buildQzoneAuditLedger(input.audit, input.observations, policy, runs, now);
}

function expectUnavailable(rate: AuditRate, reason: string): void {
  expect(rate).toMatchObject({ numerator: null, denominator: null, ratio: null });
  expect(rate.unavailableReasonCodes).toContain(reason);
}

describe('QZone manual post-identity capture ledger', () => {
  it('reports missed posts as of cutoff, partial captures and declared failures without claiming publication or benchmark eligibility', () => {
    const runs = [run(0, [acquired('A')])];
    const input = declarations([auditItem('A'), auditItem('B', time(), 'no')], runs);
    input.observations.attempts.push({ outcome: 'failed', attemptedAt: '2026-10-08T08:00:00Z', failureCode: 'authentication' });
    const result = buildQzoneAuditLedger(input.audit, input.observations, policy, runs, now);
    expect(result.counts).toEqual({
      auditedItems: 2, knownInWindow: 2, unresolvedAuditTimes: 0, capturedKnown: 1, missingKnown: 1,
      capturedPartial: 1, timeConflicts: 0, unauditedAcquired: 0, outOfWindowAcquired: 0,
      actionableYes: 1, actionableNo: 1, actionableUnknown: 0,
    });
    expect(result.items[0]).toMatchObject({ captureStatus: 'captured', contentCompleteness: 'partial', firstSeenAt: '2026-10-08T06:40:00.000Z', acquisitionLagMs: 600000 });
    expect(result.items[1]).toMatchObject({ captureStatus: 'missing', contentCompleteness: 'not-acquired', firstSeenAt: null, sourceRunIds: [], acquisitionLagMs: null });
    expect(result.rates.postIdentityCapture).toEqual({ numerator: 1, denominator: 2, ratio: 0.5, unavailableReasonCodes: [] });
    expect(result.rates.actionablePostCapture).toEqual({ numerator: 1, denominator: 1, ratio: 1, unavailableReasonCodes: [] });
    expect(result.observations).toMatchObject({ declaredAttemptCount: 2, verifiedSuccessCount: 1, declaredFailureCount: 1, incompleteSuccessCount: 1, lastAttemptAt: '2026-10-08T08:00:00Z', lastSuccessAt: runs[0]!.completedAt });
    expect(result.observations.failureCounts).toEqual({ authentication: 1, 'rate-limited': 0, provider: 0, transport: 0, 'invalid-response': 0 });
    expect(result).toMatchObject({ publicationEligible: false, bundleEligible: false, benchmarkStarted: false });
    expect(result.source).toEqual({ sourceId: policy.source.sourceId, publisherIdentity: publisher, role: 'relay', policyVersion: 'policy-v1', policySha256: qzonePolicySha256(policy) });
  });

  it('deduplicates sightings, preserves native case and audit order, and finds first-seen across unordered runs', () => {
    const early = run(0, [acquired('CaseTid'), acquired('caseTid', '2026-10-08T06:40:30Z')]);
    const late = run(1, [acquired('CaseTid', '2026-10-08T08:01:00Z')], '2026-10-08T08:00:00Z', '2026-10-08T08:02:00Z');
    const result = ledger([auditItem('caseTid'), auditItem('CaseTid')], [late, early]);
    expect(result.items.map((item) => item.nativeIdentity)).toEqual([auditItem('caseTid').nativeIdentity, auditItem('CaseTid').nativeIdentity]);
    expect(result.items[0]!.sourceItemId).not.toBe(result.items[1]!.sourceItemId);
    expect(result.items[1]).toMatchObject({ firstSeenAt: early.items[0]!.acquiredAt, sourceRunIds: [late.runId, early.runId] });
    expect(result.counts).toMatchObject({ capturedKnown: 2, capturedPartial: 2, missingKnown: 0 });
    expect(result.observations.lastNewItemObservedAt).toBe('2026-10-08T06:40:30Z');
    expect(result.observations.firstAttemptAt).toBe(early.startedAt);
    expect(result.observations.lastAttemptAt).toBe(late.startedAt);
    expect(result.observations.lastSuccessAt).toBe(late.completedAt);
    expect(ledger([auditItem('caseTid'), auditItem('CaseTid')], [early, late]).items.map((item) => item.firstSeenAt)).toEqual(result.items.map((item) => item.firstSeenAt));
  });

  it('scopes new-item timestamps to all supplied identities while empty successes and failed attempts remain separate', () => {
    const early = run(0, [acquired('A'), acquired('A', '2026-10-08T06:40:30Z')]);
    const outside = run(1, [acquired('Outside', '2026-10-08T08:01:00Z', time('2026-10-08T05:30:00Z'))], '2026-10-08T08:00:00Z', '2026-10-08T08:02:00Z');
    const empty = run(2, [], '2026-10-08T08:30:00Z', '2026-10-08T08:31:00Z');
    const input = declarations(undefined, [empty, outside, early]);
    input.observations.attempts.push({ outcome: 'failed', attemptedAt: '2026-10-08T08:59:00Z', failureCode: 'provider' });
    const result = buildQzoneAuditLedger(input.audit, input.observations, policy, [early, empty, outside], now);
    expect(result.items[0]!.sourceRunIds).toEqual([early.runId]);
    expect(result.items[0]!.firstSeenAt).toBe('2026-10-08T06:40:00.000Z');
    expect(result.observations).toMatchObject({ lastAttemptAt: '2026-10-08T08:59:00Z', lastSuccessAt: empty.completedAt, lastNewItemObservedAt: '2026-10-08T08:01:00Z' });
    expect(result.counts).toMatchObject({ capturedKnown: 1, capturedPartial: 1, outOfWindowAcquired: 1 });
    expect(result.rates.postIdentityCapture.ratio).toBe(1);
  });

  it('keeps the audit window separate from capture cutoff and accepts captures at cutoff after audit observation', () => {
    const late = run(0, [acquired('A', '2026-10-08T09:00:00Z')], '2026-10-08T08:59:00Z', '2026-10-08T09:00:00Z');
    const result = ledger([auditItem('A')], [late]);
    expect(result.rates.postIdentityCapture.ratio).toBe(1);
    expect(result.items[0]!.firstSeenAt).toBe('2026-10-08T09:00:00Z');
    expect(result.items[0]!.acquisitionLagMs).toBe(9000000);
    expect(result.captureCutoffAt).toBe('2026-10-08T09:00:00.000Z');
  });

  it('supports failure-only observations and separately counts every declared failure category', () => {
    const input = declarations();
    input.observations.attempts = ['authentication', 'rate-limited', 'provider', 'transport', 'invalid-response'].map((failureCode) => ({
      outcome: 'failed' as const, attemptedAt: '2026-10-08T06:00:00Z', failureCode: failureCode as 'authentication' | 'rate-limited' | 'provider' | 'transport' | 'invalid-response',
    }));
    const result = buildQzoneAuditLedger(input.audit, input.observations, policy, [], now);
    expect(result.observations).toMatchObject({ verifiedSuccessCount: 0, declaredFailureCount: 5, incompleteSuccessCount: 0, lastSuccessAt: null, lastNewItemObservedAt: null, successfulRuns: [] });
    expect(Object.values(result.observations.failureCounts)).toEqual([1, 1, 1, 1, 1]);
    expect(result.counts.missingKnown).toBe(1);
    expect(result.rates.postIdentityCapture).toMatchObject({ numerator: 0, denominator: 1, ratio: 0 });
  });

  it('does not turn empty success or no observations into an invented 100% rate', () => {
    for (const runs of [[], [run(0)]]) {
      const result = ledger([], runs);
      expect(result.audit.effectiveCoverage).toBe('complete');
      expect(result.rates.postIdentityCapture).toEqual({ numerator: 0, denominator: 0, ratio: null, unavailableReasonCodes: ['zero-denominator'] });
      expect(result.rates.actionablePostCapture).toEqual(result.rates.postIdentityCapture);
      expect(result.observations).toMatchObject({ verifiedSuccessCount: runs.length, incompleteSuccessCount: runs.length, lastNewItemObservedAt: null });
    }
    const noAttempts = ledger([]).observations;
    expect(noAttempts.firstAttemptAt).toBeNull();
    expect(noAttempts.lastAttemptAt).toBeNull();
    expect(noAttempts.lastSuccessAt).toBeNull();
    const noActionable = ledger([auditItem('A', time(), 'no')]);
    expect(noActionable.rates.actionablePostCapture).toEqual({ numerator: 0, denominator: 0, ratio: null, unavailableReasonCodes: ['zero-denominator'] });
  });

  it.each(['audit-declared-incomplete', 'audit-observed-before-window-end'])('suppresses complete denominators for %s even when known counts are available', (reason) => {
    const input = declarations();
    if (reason === 'audit-declared-incomplete') input.audit.coverage.status = 'incomplete';
    else input.audit.observedAt = '2026-10-08T06:59:59Z';
    const result = buildQzoneAuditLedger(input.audit, input.observations, policy, [], now);
    expect(result.audit.effectiveCoverage).toBe('incomplete');
    expect(result.counts).toMatchObject({ knownInWindow: 1, missingKnown: 1 });
    expectUnavailable(result.rates.postIdentityCapture, reason);
    expectUnavailable(result.rates.actionablePostCapture, reason);
    input.audit.items = [];
    expectUnavailable(buildQzoneAuditLedger(input.audit, input.observations, policy, [], now).rates.postIdentityCapture, reason);
  });

  it('suppresses only actionable capture when a label is unknown', () => {
    const result = ledger([auditItem('A', time(), 'unknown')], [run(0, [acquired('A')])]);
    expect(result.audit.effectiveCoverage).toBe('complete');
    expect(result.audit.limitationCodes).toContain('actionable-labels-unresolved');
    expect(result.rates.postIdentityCapture).toEqual({ numerator: 1, denominator: 1, ratio: 1, unavailableReasonCodes: [] });
    expectUnavailable(result.rates.actionablePostCapture, 'actionable-labels-unresolved');
    expect(result.counts.actionableUnknown).toBe(1);
  });

  it('detects missing manual identities but keeps out-of-window acquisitions separate', () => {
    const result = ledger([], [run(0, [acquired('Unlisted'), acquired('Outside', undefined, time('2026-10-08T05:59:59Z'))])]);
    expect(result.counts).toMatchObject({ unauditedAcquired: 1, outOfWindowAcquired: 1 });
    expect(result.unauditedItems).toEqual([{
      nativeIdentity: auditItem('Unlisted').nativeIdentity, sourceItemId: acquired('Unlisted').sourceItemId,
      firstSeenAt: '2026-10-08T06:40:00.000Z', sourceRunIds: [ids[0]],
    }]);
    expectUnavailable(result.rates.postIdentityCapture, 'unlisted-acquired-posts');
    const outsideOnly = ledger([], [run(0, [acquired('Outside', '2026-10-08T07:01:00Z', time('2026-10-08T07:00:00Z'))],
      '2026-10-08T07:00:30Z', '2026-10-08T07:01:30Z')]);
    expect(outsideOnly.audit.effectiveCoverage).toBe('complete');
    expect(outsideOnly.counts.outOfWindowAcquired).toBe(1);
    expect(outsideOnly.rates.postIdentityCapture.unavailableReasonCodes).toEqual(['zero-denominator']);
  });
});

describe('QZone publication precision and uncertainty', () => {
  it('uses half-open publication precision intervals at both window boundaries', () => {
    const input = declarations([auditItem('A', time('2026-10-08T06:00:00Z')), auditItem('B', time('2026-10-08T06:59:59Z'))]);
    expect(buildQzoneAuditLedger(input.audit, input.observations, policy, [], now).counts.knownInWindow).toBe(2);
    for (const value of ['2026-10-08T05:59:59Z', '2026-10-08T07:00:00Z']) {
      input.audit.items = [auditItem('Outside', time(value))];
      expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow('outside');
    }
    input.audit.items = [auditItem('Boundary', time('2026-10-08T06:00Z', 'minute'))];
    input.audit.window.startAt = '2026-10-08T06:00:30Z';
    const boundary = buildQzoneAuditLedger(input.audit, input.observations, policy, [], now);
    expect(boundary.items[0]).toMatchObject({ windowMembership: 'uncertain', captureStatus: 'unknown', acquisitionLagMs: null });
    expect(boundary.counts).toMatchObject({ knownInWindow: 0, unresolvedAuditTimes: 1, missingKnown: 0 });
    expectUnavailable(boundary.rates.postIdentityCapture, 'audit-time-unresolved');
    input.audit.window = { startAt: '2026-10-08T06:00:00Z', endAt: '2026-10-08T06:00:30Z' };
    expect(buildQzoneAuditLedger(input.audit, input.observations, policy, [], now).items[0]!.windowMembership).toBe('uncertain');
  });

  it.each([
    unknownTime,
    { original: { value: '2026-10-08', representation: 'iso8601' }, precision: 'day', timezone: null, normalizedAt: null, publishedOn: '2026-10-08' },
    { original: { value: '2026年10月8日', representation: 'text' }, precision: 'day', timezone: null, normalizedAt: null, publishedOn: '2026-10-08' },
    { original: { value: 'yesterday evening', representation: 'text' }, precision: 'unknown', timezone: null, normalizedAt: null, publishedOn: null },
  ] as SocialEnvelopePayload['publicationTime'][])('does not manufacture instants, conflicts or missing counts for uncertain audit time %j', (publicationTime) => {
    const result = ledger([auditItem('A', publicationTime)], [run(0, [acquired('A')])]);
    expect(result.items[0]).toMatchObject({ publicationTime, captureStatus: 'unknown', firstSeenAt: '2026-10-08T06:40:00.000Z', contentCompleteness: 'partial', acquisitionLagMs: null });
    expect(result.counts).toMatchObject({ unresolvedAuditTimes: 1, capturedKnown: 0, missingKnown: 0, capturedPartial: 1, timeConflicts: 0 });
    expectUnavailable(result.rates.postIdentityCapture, 'audit-time-unresolved');
  });

  it('derives exact machine-original times without needing normalizedAt and retains milliseconds', () => {
    const second: SocialEnvelopePayload['publicationTime'] = { original: { value: String(Date.parse('2026-10-08T06:30:00Z') / 1000), representation: 'unix-seconds' }, precision: 'second', timezone: null, normalizedAt: null, publishedOn: null };
    const millisecond: SocialEnvelopePayload['publicationTime'] = { original: { value: String(Date.parse('2026-10-08T06:30:00.123Z')), representation: 'unix-milliseconds' }, precision: 'millisecond', timezone: null, normalizedAt: null, publishedOn: null };
    const result = ledger([auditItem('Second', second), auditItem('Millisecond', millisecond)], [run(0, [acquired('Second', undefined, second), acquired('Millisecond', undefined, millisecond)])]);
    expect(result.items.map((item) => item.acquisitionLagMs)).toEqual([600000, 599877]);
    expect(result.rates.postIdentityCapture.ratio).toBe(1);
    expect(result.items[1]!.publicationTime).toEqual(millisecond);
    const normalized = { ...millisecond, normalizedAt: '2026-10-08T14:30:00.123+08:00' };
    expect(ledger([auditItem('A', normalized)], [run(0, [acquired('A', undefined, millisecond)])]).items[0]!.acquisitionLagMs).toBe(599877);
  });

  it('accepts narrower provider precision inside audit precision but does not invent minute lags', () => {
    const result = ledger([auditItem('A', time('2026-10-08T06:30Z', 'minute'))], [run(0, [acquired('A', undefined, time('2026-10-08T06:30:45Z'))])]);
    expect(result.items[0]).toMatchObject({ captureStatus: 'captured', acquisitionLagMs: null });
    expect(result.rates.postIdentityCapture.ratio).toBe(1);
    const milliseconds = ledger([auditItem('A')], [run(0, [acquired('A', undefined, time('2026-10-08T06:30:00.500Z', 'millisecond'))])]);
    expect(milliseconds.items[0]!.captureStatus).toBe('captured');
  });

  it.each([
    time('2026-10-08T06:31:00Z'), time('2026-10-08T06:30Z', 'minute'),
  ])('marks incompatible provider time as conflict rather than valid capture or missing %j', (publicationTime) => {
    const result = ledger([auditItem('A')], [run(0, [acquired('A', undefined, publicationTime)])]);
    expect(result.items[0]).toMatchObject({ captureStatus: 'time-conflict', contentCompleteness: 'partial', acquisitionLagMs: null });
    expect(result.counts).toMatchObject({ timeConflicts: 1, capturedKnown: 0, missingKnown: 0, capturedPartial: 1 });
    expectUnavailable(result.rates.postIdentityCapture, 'publication-time-conflict');
  });

  it('detects different provider instants across sightings even if both fit a minute audit', () => {
    const first = run(0, [acquired('A')]);
    const second = run(1, [acquired('A', '2026-10-08T08:01:00Z', time('2026-10-08T06:30:01Z'))], '2026-10-08T08:00:00Z', '2026-10-08T08:02:00Z');
    for (const runs of [[first, second], [second, first]]) {
      const result = ledger([auditItem('A', time('2026-10-08T06:30Z', 'minute'))], runs);
      expect(result.items[0]!.captureStatus).toBe('time-conflict');
      expect(result.counts.timeConflicts).toBe(1);
      expectUnavailable(result.rates.postIdentityCapture, 'publication-time-conflict');
    }
  });

  it('suppresses coverage for unaudited acquisition uncertainty and conflicts, never silently discards them', () => {
    const uncertain = ledger([], [run(0, [acquired('Unknown', undefined, unknownTime)])]);
    expectUnavailable(uncertain.rates.postIdentityCapture, 'acquisition-time-unresolved');
    const first = run(0, [acquired('Conflict')]);
    const second = run(1, [acquired('Conflict', '2026-10-08T08:01:00Z', time('2026-10-08T06:31:00Z'))], '2026-10-08T08:00:00Z', '2026-10-08T08:02:00Z');
    const conflict = ledger([], [first, second]);
    expect(conflict.counts.timeConflicts).toBe(1);
    expectUnavailable(conflict.rates.postIdentityCapture, 'publication-time-conflict');
    const boundary = run(0, [acquired('Boundary', '2026-10-08T07:01:00Z', time('2026-10-08T06:59Z', 'minute'))],
      '2026-10-08T07:00:00Z', '2026-10-08T07:02:00Z');
    const input = declarations([], [boundary]);
    input.audit.window.endAt = '2026-10-08T06:59:30Z';
    expectUnavailable(buildQzoneAuditLedger(input.audit, input.observations, policy, [boundary], now).rates.postIdentityCapture, 'acquisition-time-unresolved');
  });

  it('does not call a sighting with unresolved provider time a missing or compatible captured post', () => {
    const result = ledger([auditItem('A')], [run(0, [acquired('A', undefined, unknownTime)])]);
    expect(result.items[0]!.captureStatus).toBe('unknown');
    expect(result.counts).toMatchObject({ capturedKnown: 0, missingKnown: 0, capturedPartial: 1, timeConflicts: 0 });
    expectUnavailable(result.rates.postIdentityCapture, 'acquisition-time-unresolved');
  });

  it('reports prepublication acquisition clocks as conflicts, never valid captured numerators or negative lags', () => {
    const result = ledger([auditItem('A', time('2026-10-08T06:50:00Z'))], [run(0, [acquired('A', undefined, time('2026-10-08T06:50:00Z'))])]);
    expect(result.items[0]!.captureStatus).toBe('time-conflict');
    expect(result.items[0]!.acquisitionLagMs).toBeNull();
    expect(result.counts).toMatchObject({ capturedKnown: 0, missingKnown: 0, capturedPartial: 1, timeConflicts: 1 });
    expectUnavailable(result.rates.postIdentityCapture, 'publication-time-conflict');
  });
});

describe('QZone strict declarations and verified-summary join', () => {
  it('canonicalizes lexical run paths and rejects duplicate paths and same-instant failures', () => {
    const summary = run(0, [acquired('A')]);
    const input = declarations(undefined, [summary]);
    const attempt = input.observations.attempts[0]!;
    if (attempt.outcome !== 'success') throw new Error('Synthetic success required');
    attempt.runDirectory = `/private/synthetic-acquisitions/child/../${summary.runId}/`;
    expect(parseQzoneAuditInputs(input.audit, input.observations, policy, now).observations.attempts[0]).toMatchObject({ runDirectory: summary.inputDir });
    expect(buildQzoneAuditLedger(input.audit, input.observations, policy, [summary], now).counts.capturedKnown).toBe(1);
    input.observations.attempts.push({ ...attempt, runDirectory: summary.inputDir });
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow('Duplicate');
    input.observations.attempts = [
      { outcome: 'failed', attemptedAt: '2026-10-08T06:00:00Z', failureCode: 'provider' },
      { outcome: 'failed', attemptedAt: '2026-10-08T14:00:00+08:00', failureCode: 'provider' },
    ];
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow('Duplicate');
    input.observations.attempts[1] = { outcome: 'failed', attemptedAt: '2026-10-08T06:00:01Z', failureCode: 'provider' };
    expect(parseQzoneAuditInputs(input.audit, input.observations, policy, now).observations.attempts).toHaveLength(2);
  });

  it('rejects duplicate manual declarations without lowercasing distinct native identities', () => {
    const input = declarations([auditItem('CaseTid'), auditItem('CaseTid')]);
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow('Duplicate');
    input.audit.items[1] = auditItem('caseTid');
    expect(parseQzoneAuditInputs(input.audit, input.observations, policy, now).audit.items).toHaveLength(2);
  });

  it.each(['body', 'title', 'images', 'comments', 'viewer', 'session'])('rejects private publisher fields %s rather than carrying them into ledger rows', (field) => {
    const input = declarations();
    Object.assign(input.audit.items[0]!, { [field]: 'PRIVATE_PUBLISHER_CONTENT' });
    expect(() => buildQzoneAuditLedger(input.audit, input.observations, policy, [], now)).toThrow('declaration');
    const summary = run(0, [acquired('A')]);
    const clean = declarations(undefined, [summary]);
    Object.assign(summary.items[0]!, { [field]: 'PRIVATE_PUBLISHER_CONTENT' });
    expect(() => buildQzoneAuditLedger(clean.audit, clean.observations, policy, [summary], now)).toThrow('summaries');
  });

  it('rejects unknown keys recursively in both declaration types', () => {
    const mutations: Array<(input: { audit: QzoneManualAudit; observations: QzoneObservations }) => void> = [
      ({ audit }) => { Object.assign(audit, { unknown: true }); },
      ({ audit }) => { Object.assign(audit.window, { unknown: true }); },
      ({ audit }) => { Object.assign(audit.coverage, { unknown: true }); },
      ({ audit }) => { Object.assign(audit.publisherIdentity, { unknown: true }); },
      ({ audit }) => { Object.assign(audit.items[0]!.nativeIdentity, { unknown: true }); },
      ({ audit }) => { Object.assign(audit.items[0]!.publicationTime, { unknown: true }); },
      ({ audit }) => { Object.assign(audit.items[0]!.publicationTime.original!, { unknown: true }); },
      ({ observations }) => { Object.assign(observations, { unknown: true }); },
      ({ observations }) => { Object.assign(observations.publisherIdentity, { unknown: true }); },
      ({ observations }) => { Object.assign(observations.attempts[0]!, { unknown: true }); },
    ];
    for (const mutate of mutations) {
      const input = structuredClone(declarations(undefined, [run(0)]));
      mutate(input);
      expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
    }
    const input = declarations();
    input.observations.attempts = [{ outcome: 'failed', attemptedAt: '2026-10-08T06:00:00Z', failureCode: 'provider' }];
    Object.assign(input.observations.attempts[0]!, { runDirectory: '/private/run', error: 'PRIVATE_ERROR', response: {} });
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
  });

  it.each(['relative/run', '/private/.partial-run', '/private/run\u0000', '/private/not-a-uuid'])('rejects noncompleted or invalid success paths %s', (runDirectory) => {
    const input = declarations();
    input.observations.attempts = [{ outcome: 'success', attemptedAt: '2026-10-08T06:30:00Z', runDirectory }];
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
  });

  it('requires exact success coverage rather than manufacturing missing or failed runs into empty success', () => {
    const first = run(0);
    const second = run(1);
    const input = declarations(undefined, [first, second]);
    expect(() => buildQzoneAuditLedger(input.audit, input.observations, policy, [first], now)).toThrow('every declared success');
    expect(() => buildQzoneAuditLedger(input.audit, input.observations, policy, [first, first], now)).toThrow();
    input.observations.attempts = [];
    expect(() => buildQzoneAuditLedger(input.audit, input.observations, policy, [first], now)).toThrow();
    input.observations.attempts = [{ outcome: 'failed', attemptedAt: first.startedAt, failureCode: 'provider' }];
    expect(() => buildQzoneAuditLedger(input.audit, input.observations, policy, [first], now)).toThrow();
  });

  it.each([
    { sourceId: 'other-source' }, { publisherIdentity: { ...publisher, value: '10002' } },
    { publisherIdentity: { ...publisher, version: 2 } }, { manifestSha256: 'FORGED_HASH' },
    { runId: ids[1] }, { startedAt: '2026-10-08T06:39:01Z' },
    { completedAt: '2026-10-08T06:38:00Z' }, { completedAt: '2026-10-08T09:00:00.001Z' },
  ])('rejects summary source/identity/manifest/run/clock mismatch %j', (change) => {
    const summary = run(0, [acquired('A')]);
    const input = declarations(undefined, [summary]);
    Object.assign(summary, change);
    expect(() => buildQzoneAuditLedger(input.audit, input.observations, policy, [summary], now)).toThrow();
  });

  it.each([
    { sourceItemId: acquired('Other').sourceItemId },
    { nativeIdentity: { scheme: 'qzone-tid', version: 2, tid: 'A' } },
    { acquiredAt: '2026-10-08T06:38:59.999Z' }, { acquiredAt: '2026-10-08T06:41:00.001Z' },
    { acquiredAt: '2026-10-08T06:40:00.0001Z' }, { contentCompleteness: 'full' },
  ])('rejects forged detail identity, precision, completeness or evidence span %j', (change) => {
    const summary = run(0, [acquired('A')]);
    const input = declarations(undefined, [summary]);
    Object.assign(summary.items[0]!, change);
    expect(() => buildQzoneAuditLedger(input.audit, input.observations, policy, [summary], now)).toThrow();
  });

  it('accepts equivalent explicit-offset success start instants without rewriting declarations', () => {
    const summary = run(0, [acquired('A')]);
    const input = declarations(undefined, [summary]);
    input.observations.attempts[0]!.attemptedAt = '2026-10-08T14:39:00+08:00';
    const result = buildQzoneAuditLedger(input.audit, input.observations, policy, [summary], now);
    expect(result.observations.firstAttemptAt).toBe('2026-10-08T14:39:00+08:00');
    expect(result.counts.capturedKnown).toBe(1);
  });

  it('rejects mismatched source/publisher/versions in either manual declaration', () => {
    for (const name of ['audit', 'observations'] as const) {
      for (const change of [{ sourceId: 'other-source' }, { publisherIdentity: { ...publisher, value: '10002' } }, { publisherIdentity: { ...publisher, version: 2 } }]) {
        const input = declarations();
        Object.assign(input[name], change);
        expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
      }
    }
    const input = declarations();
    Object.assign(input.audit.items[0]!.nativeIdentity, { version: 2 });
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
  });

  it.each(['2026-10-08T06:00:00', '2026-02-30T06:00:00Z', '2026-10-08T06:00:00.0001Z', 'not-a-time'])('rejects invalid/nonoffset/submillisecond observation clocks %s', (timestamp) => {
    const input = declarations();
    input.audit.observedAt = timestamp;
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
    input.audit.observedAt = '2026-10-08T07:01:00Z';
    input.observations.captureCutoffAt = timestamp;
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
    input.observations.captureCutoffAt = '2026-10-08T09:00:00Z';
    input.observations.attempts = [{ outcome: 'failed', attemptedAt: timestamp, failureCode: 'provider' }];
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
  });

  it('rejects inconsistent windows and attempt bounds while allowing both inclusive attempt endpoints', () => {
    for (const change of [
      { startAt: '2026-10-08T07:00:00Z', endAt: '2026-10-08T07:00:00Z' },
      { startAt: '2026-10-08T08:00:00Z', endAt: '2026-10-08T07:00:00Z' },
      { startAt: '2026-10-08T06:00:00Z', endAt: '2026-10-08T09:00:00.001Z' },
    ]) {
      const input = declarations();
      input.audit.window = change;
      expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
    }
    for (const observedAt of ['2026-10-08T05:59:59.999Z', '2026-10-08T10:00:00.001Z']) {
      const input = declarations();
      input.audit.observedAt = observedAt;
      expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
    }
    for (const attemptedAt of ['2026-10-08T05:59:59.999Z', '2026-10-08T09:00:00.001Z']) {
      const input = declarations();
      input.observations.attempts = [{ outcome: 'failed', attemptedAt, failureCode: 'provider' }];
      expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
    }
    const input = declarations();
    input.observations.attempts = ['2026-10-08T06:00:00Z', '2026-10-08T09:00:00Z'].map((attemptedAt) => ({ outcome: 'failed', attemptedAt, failureCode: 'provider' }));
    expect(parseQzoneAuditInputs(input.audit, input.observations, policy, now).observations.attempts).toHaveLength(2);
    input.observations.captureCutoffAt = '2026-10-08T10:00:00.001Z';
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
  });

  it('rejects invalid operation clocks, expired/future policy qualification and policies outside the offline relay/sentinel slice', () => {
    const input = declarations();
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, new Date(NaN))).toThrow('clock');
    for (const change of [{ reviewUntil: now.toISOString() }, { reviewedAt: '2026-10-09T00:00:00Z' }, { reviewedAt: '2026-10-01T00:00:00.0001Z' }]) {
      expect(() => parseQzoneAuditInputs(input.audit, input.observations, { ...policy, qualification: { ...policy.qualification, ...change } }, now)).toThrow();
    }
    for (const change of [{ role: 'official' }, { redistributionMode: 'full' }, { access: 'anonymous' }, { policyVersion: ' ' }]) {
      expect(() => parseQzoneAuditInputs(input.audit, input.observations, { ...policy, source: { ...policy.source, ...change } }, now)).toThrow();
    }
    expect(buildQzoneAuditLedger(input.audit, input.observations, { ...policy, source: { ...policy.source, role: 'sentinel' } }, [], now).source.role).toBe('sentinel');
    const refreshed = { ...policy, source: { ...policy.source, policyVersion: 'policy-v2' } };
    expect(buildQzoneAuditLedger(input.audit, input.observations, refreshed, [], now).source.policySha256).not.toBe(qzonePolicySha256(policy));
  });

  it('enforces bounded declaration counts and nonblank private assertions', () => {
    const input = declarations();
    input.audit.items = Array.from({ length: 10001 }, (_, index) => auditItem(`Tid${index}`));
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
    input.audit.items = [auditItem('A')];
    input.observations.attempts = Array.from({ length: 1025 }, (_, index) => ({ outcome: 'failed', attemptedAt: new Date(Date.parse('2026-10-08T06:00:00Z') + index).toISOString(), failureCode: 'provider' }));
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
    input.observations.attempts = [];
    for (const field of ['auditor', 'publicAudienceEvidence'] as const) {
      const invalid = structuredClone(input.audit);
      invalid[field] = ' \t';
      expect(() => parseQzoneAuditInputs(invalid, input.observations, policy, now)).toThrow();
    }
    input.audit.coverage.reason = ' ';
    expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
  });

  it('rejects publication representations that invent precision or silently truncate source instants', () => {
    const invalidTimes = [
      { ...time(), normalizedAt: '2026-10-08T06:30:00.0001Z' },
      { ...time(), normalizedAt: '2026-10-08T06:30:01Z' },
      time('2026-10-08T06:30:00.0001Z', 'millisecond'),
      { ...unknownTime, original: { value: 'yesterday', representation: 'text' }, precision: 'second', normalizedAt: '2026-10-08T06:30:00Z' },
      { ...unknownTime, original: { value: '2026-10-08', representation: 'iso8601' }, precision: 'second' },
    ];
    for (const publicationTime of invalidTimes) {
      const input = declarations();
      Object.assign(input.audit.items[0]!, { publicationTime });
      expect(() => parseQzoneAuditInputs(input.audit, input.observations, policy, now)).toThrow();
    }
  });

  it('exposes unlisted prepublication clocks and gives conflicting boundary sightings order-independent limitations', () => {
    const unlisted = ledger([], [run(0, [acquired('A', undefined, time('2026-10-08T06:50:00Z'))])]);
    expect(unlisted.counts.timeConflicts).toBe(1);
    expectUnavailable(unlisted.rates.postIdentityCapture, 'publication-time-conflict');
    const inside = run(0, [acquired('A')]);
    const outside = run(1, [acquired('A', '2026-10-08T08:01:00Z', time('2026-10-08T07:00:00Z'))], '2026-10-08T08:00:00Z', '2026-10-08T08:02:00Z');
    const first = ledger([], [inside, outside]);
    const reversed = ledger([], [outside, inside]);
    expect(first.rates).toEqual(reversed.rates);
    expect(first.counts).toEqual(reversed.counts);
    expect(first.audit.limitationCodes).toEqual(['publication-time-conflict']);
  });

  it('does not mutate inputs or leak private paths, bodies, media locators or qualification text into ledger items', () => {
    const summaries = [run(0, [acquired('A')])];
    const input = declarations(undefined, summaries);
    const before = structuredClone({ ...input, policy, summaries });
    const result = buildQzoneAuditLedger(input.audit, input.observations, policy, summaries, now);
    expect({ ...input, policy, summaries }).toEqual(before);
    const output = JSON.stringify(result);
    expect(output).not.toContain('/private/synthetic-acquisitions');
    expect(output).not.toContain(policy.qualification.redistributionBasis);
    expect(output).not.toContain('PRIVATE_PUBLISHER_CONTENT');
    expect(output).not.toContain('mediaUrls');
    expect(output).not.toContain('rawEvidence');
    expect(JSON.stringify(result.items)).not.toContain('PRIVATE_');
    expect(result.audit.auditor).toBe('PRIVATE_AUDITOR');
    expect(result.audit.declaredCoverage.reason).toBe('PRIVATE_COVERAGE_REASON');
  });
});
