import path from 'node:path';
import { socialEnvelopePayloadSchema, socialSourceItemId, type SocialEnvelopePayload } from '@nju-info/core';
import { z } from 'zod';
import type { QzonePolicy } from './config.js';
import { parseQzoneReviewPolicy, qzonePolicySha256 } from './review-model.js';

const nonblank = z.string().refine((value) => value.trim().length > 0);
const timestampSchema = z.iso.datetime({ offset: true }).refine(
  (value) => !/\.\d{4}/.test(value) && Number.isFinite(Date.parse(value)),
);
const publisherSchema = socialEnvelopePayloadSchema.shape.source.shape.publisherIdentity.refine(
  (identity) => identity.scheme === 'qzone-uin',
);
const nativeSchema = socialEnvelopePayloadSchema.shape.item.shape.nativeIdentity.refine(
  (identity) => identity.scheme === 'qzone-tid',
);
const publicationTimeSchema = socialEnvelopePayloadSchema.shape.publicationTime;
const failureCodes = ['authentication', 'rate-limited', 'provider', 'transport', 'invalid-response'] as const;
const runDirectorySchema = z.string().refine(
  (value) => path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value),
).transform((value) => path.resolve(value)).refine((value) => z.uuid().safeParse(path.basename(value)).success);
const manualSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: socialEnvelopePayloadSchema.shape.source.shape.sourceId,
  publisherIdentity: publisherSchema,
  window: z.object({ startAt: timestampSchema, endAt: timestampSchema }).strict(),
  observedAt: timestampSchema,
  method: z.literal('manual-public-profile'),
  auditor: nonblank,
  publicAudienceEvidence: nonblank,
  coverage: z.object({ status: z.enum(['complete', 'incomplete']), reason: nonblank }).strict(),
  items: z.array(z.object({
    nativeIdentity: nativeSchema,
    publicationTime: publicationTimeSchema,
    actionable: z.enum(['yes', 'no', 'unknown']),
  }).strict()).max(10000),
}).strict();
const observationsSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: socialEnvelopePayloadSchema.shape.source.shape.sourceId,
  publisherIdentity: publisherSchema,
  captureCutoffAt: timestampSchema,
  attempts: z.array(z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('success'), attemptedAt: timestampSchema, runDirectory: runDirectorySchema }).strict(),
    z.object({ outcome: z.literal('failed'), attemptedAt: timestampSchema, failureCode: z.enum(failureCodes) }).strict(),
  ])).max(1024),
}).strict();
const summarySchema = z.object({
  inputDir: runDirectorySchema,
  runId: z.uuid(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceId: socialEnvelopePayloadSchema.shape.source.shape.sourceId,
  publisherIdentity: publisherSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  items: z.array(z.object({
    sourceItemId: socialEnvelopePayloadSchema.shape.item.shape.sourceItemId,
    nativeIdentity: nativeSchema,
    publicationTime: publicationTimeSchema,
    acquiredAt: timestampSchema,
    contentCompleteness: z.literal('partial'),
  }).strict()),
}).strict();

export interface QzoneManualAudit extends z.infer<typeof manualSchema> {}
export interface QzoneObservations extends z.infer<typeof observationsSchema> {}
export interface QzoneAcquisitionSummary extends z.infer<typeof summarySchema> {}
export interface AuditRate {
  numerator: number | null;
  denominator: number | null;
  ratio: number | null;
  unavailableReasonCodes: string[];
}
export interface QzoneAuditLedger {
  schemaVersion: 1;
  kind: 'qzone-manual-audit';
  source: Pick<QzonePolicy['source'], 'sourceId' | 'publisherIdentity' | 'role' | 'policyVersion'> & { policySha256: string };
  window: QzoneManualAudit['window'];
  captureCutoffAt: string;
  audit: {
    method: 'manual-public-profile'; auditor: string; observedAt: string; publicAudienceEvidence: string;
    declaredCoverage: QzoneManualAudit['coverage']; effectiveCoverage: 'complete' | 'incomplete'; limitationCodes: string[];
  };
  counts: {
    auditedItems: number; knownInWindow: number; unresolvedAuditTimes: number; capturedKnown: number; missingKnown: number;
    // Physical partial sightings among audited IDs, including uncertain/conflicting rows; not a rate numerator.
    capturedPartial: number;
    // Unique affected native IDs, including identities absent from the manual audit.
    timeConflicts: number;
    // Only determinate inside-window unlisted groups; uncertain groups suppress rates instead.
    unauditedAcquired: number; outOfWindowAcquired: number;
    actionableYes: number; actionableNo: number; actionableUnknown: number;
  };
  observations: {
    declaredAttemptCount: number; verifiedSuccessCount: number; declaredFailureCount: number; incompleteSuccessCount: number;
    // Success means latest completion; new-item means latest per-ID first sighting across supplied successes, not first-ever.
    firstAttemptAt: string | null; lastAttemptAt: string | null; lastSuccessAt: string | null; lastNewItemObservedAt: string | null;
    failureCounts: Record<typeof failureCodes[number], number>;
    successfulRuns: Array<Pick<QzoneAcquisitionSummary, 'runId' | 'manifestSha256' | 'startedAt' | 'completedAt'>>;
  };
  items: Array<{
    nativeIdentity: SocialEnvelopePayload['item']['nativeIdentity']; sourceItemId: string;
    publicationTime: SocialEnvelopePayload['publicationTime']; actionable: 'yes' | 'no' | 'unknown';
    windowMembership: 'inside' | 'uncertain'; captureStatus: 'captured' | 'missing' | 'unknown' | 'time-conflict';
    contentCompleteness: 'partial' | 'not-acquired'; firstSeenAt: string | null; sourceRunIds: string[]; acquisitionLagMs: number | null;
  }>;
  unauditedItems: Array<{
    nativeIdentity: SocialEnvelopePayload['item']['nativeIdentity']; sourceItemId: string; firstSeenAt: string | null; sourceRunIds: string[];
  }>;
  rates: { postIdentityCapture: AuditRate; actionablePostCapture: AuditRate };
  publicationEligible: false;
  bundleEligible: false;
  benchmarkStarted: false;
}

type Interval = { start: number; end: number };
type Membership = 'inside' | 'outside' | 'uncertain';

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(message);
  return result.data;
}

function publicationInterval(time: SocialEnvelopePayload['publicationTime']): Interval | null {
  if (time.precision !== 'minute' && time.precision !== 'second' && time.precision !== 'millisecond') return null;
  if (time.original === null || time.original.representation === 'text') return null;
  const start = time.normalizedAt !== null ? Date.parse(time.normalizedAt)
    : time.original.representation === 'iso8601' ? Date.parse(time.original.value)
      : Number(time.original.value) * (time.original.representation === 'unix-seconds' ? 1000 : 1);
  const width = time.precision === 'minute' ? 60000 : time.precision === 'second' ? 1000 : 1;
  if (!Number.isFinite(start)) throw new Error('Invalid QZone publication timestamp');
  return { start, end: start + width };
}

function membership(interval: Interval | null, start: number, end: number): Membership {
  if (interval === null) return 'uncertain';
  if (interval.end <= start || interval.start >= end) return 'outside';
  return interval.start >= start && interval.end <= end ? 'inside' : 'uncertain';
}

function samePublisher(left: SocialEnvelopePayload['source']['publisherIdentity'], right: SocialEnvelopePayload['source']['publisherIdentity']): boolean {
  return left.scheme === right.scheme && left.version === right.version && left.value === right.value;
}

function sourceItemId(publisher: SocialEnvelopePayload['source']['publisherIdentity'], nativeIdentity: SocialEnvelopePayload['item']['nativeIdentity']): string {
  return socialSourceItemId({ platform: 'qzone', publisher, item: nativeIdentity });
}

export function parseQzoneAuditInputs(
  auditInput: unknown, observationsInput: unknown, policyInput: unknown, now: Date = new Date(),
): { audit: QzoneManualAudit; observations: QzoneObservations; policy: QzonePolicy } {
  const currentTime = now.getTime();
  if (!Number.isFinite(currentTime)) throw new Error('Invalid QZone audit clock');
  const policy = parseQzoneReviewPolicy(policyInput, now);
  const audit = parse(manualSchema, auditInput, 'Invalid QZone manual audit declaration');
  const observations = parse(observationsSchema, observationsInput, 'Invalid QZone observation declaration');
  for (const declaration of [audit, observations]) {
    if (declaration.sourceId !== policy.source.sourceId || !samePublisher(declaration.publisherIdentity, policy.source.publisherIdentity)) {
      throw new Error('QZone audit source does not match the current policy');
    }
  }
  const start = Date.parse(audit.window.startAt);
  const end = Date.parse(audit.window.endAt);
  const cutoff = Date.parse(observations.captureCutoffAt);
  const observed = Date.parse(audit.observedAt);
  if (!(start < end && end <= cutoff && cutoff <= currentTime && observed >= start && observed <= currentTime)) {
    throw new Error('Invalid QZone audit observation window');
  }
  const identities = new Set<string>();
  for (const item of audit.items) {
    const id = sourceItemId(audit.publisherIdentity, item.nativeIdentity);
    if (identities.has(id)) throw new Error('Duplicate QZone manual audit identity');
    identities.add(id);
    if (membership(publicationInterval(item.publicationTime), start, end) === 'outside') {
      throw new Error('QZone manual audit identity is outside the audit window');
    }
  }
  const declarations = new Set<string>();
  for (const attempt of observations.attempts) {
    const attempted = Date.parse(attempt.attemptedAt);
    if (attempted < start || attempted > cutoff) throw new Error('QZone attempt is outside the capture window');
    const key = attempt.outcome === 'success' ? `success:${attempt.runDirectory}` : `failed:${attempted}:${attempt.failureCode}`;
    if (declarations.has(key)) throw new Error('Duplicate QZone observation declaration');
    declarations.add(key);
  }
  return { audit, observations, policy };
}

interface AcquiredGroup {
  nativeIdentity: SocialEnvelopePayload['item']['nativeIdentity'];
  firstSeenAt: string;
  sourceRunIds: Set<string>;
  interval: Interval | null;
  unresolved: boolean;
  conflict: boolean;
}

function rate(numerator: number, denominator: number, reasons: string[]): AuditRate {
  if (reasons.length > 0) return { numerator: null, denominator: null, ratio: null, unavailableReasonCodes: [...reasons] };
  return { numerator, denominator, ratio: denominator === 0 ? null : numerator / denominator, unavailableReasonCodes: denominator === 0 ? ['zero-denominator'] : [] };
}

/** Rates qualify operator declarations and supplied verified sightings, never independent audits or event recall. */
export function buildQzoneAuditLedger(
  auditInput: unknown, observationsInput: unknown, policyInput: unknown, runs: QzoneAcquisitionSummary[], now: Date = new Date(),
): QzoneAuditLedger {
  const { audit, observations, policy } = parseQzoneAuditInputs(auditInput, observationsInput, policyInput, now);
  const summaries = parse(z.array(summarySchema).max(1024), runs, 'Invalid QZone acquisition summaries');
  const successDeclarations = new Map(observations.attempts.flatMap((attempt) =>
    attempt.outcome === 'success' ? [[attempt.runDirectory, attempt] as const] : []));
  if (summaries.length !== successDeclarations.size) throw new Error('QZone summaries must cover every declared success exactly once');
  const start = Date.parse(audit.window.startAt);
  const end = Date.parse(audit.window.endAt);
  const cutoff = Date.parse(observations.captureCutoffAt);
  const byDirectory = new Map<string, QzoneAcquisitionSummary>();
  const runIds = new Set<string>();
  for (const summary of summaries) {
    const declaration = successDeclarations.get(summary.inputDir);
    const started = Date.parse(summary.startedAt);
    const completed = Date.parse(summary.completedAt);
    if (declaration === undefined || byDirectory.has(summary.inputDir) || runIds.has(summary.runId) ||
        path.basename(summary.inputDir) !== summary.runId || summary.sourceId !== policy.source.sourceId ||
        !samePublisher(summary.publisherIdentity, policy.source.publisherIdentity) ||
        Date.parse(declaration.attemptedAt) !== started || started > completed || completed > cutoff) {
      throw new Error('QZone acquisition summary does not match its declared success');
    }
    for (const item of summary.items) {
      const acquired = Date.parse(item.acquiredAt);
      if (acquired < started || acquired > completed || acquired > cutoff ||
          item.sourceItemId !== sourceItemId(policy.source.publisherIdentity, item.nativeIdentity)) {
        throw new Error('Invalid QZone acquisition identity or evidence clock');
      }
    }
    byDirectory.set(summary.inputDir, summary);
    runIds.add(summary.runId);
  }
  const groups = new Map<string, AcquiredGroup>();
  const successfulRuns: QzoneAuditLedger['observations']['successfulRuns'] = [];
  const failureCounts: QzoneAuditLedger['observations']['failureCounts'] = {
    authentication: 0, 'rate-limited': 0, provider: 0, transport: 0, 'invalid-response': 0,
  };
  let firstAttemptAt: string | null = null;
  let lastAttemptAt: string | null = null;
  let lastSuccessAt: string | null = null;
  for (const attempt of observations.attempts) {
    if (firstAttemptAt === null || Date.parse(attempt.attemptedAt) < Date.parse(firstAttemptAt)) firstAttemptAt = attempt.attemptedAt;
    if (lastAttemptAt === null || Date.parse(attempt.attemptedAt) > Date.parse(lastAttemptAt)) lastAttemptAt = attempt.attemptedAt;
    if (attempt.outcome === 'failed') { failureCounts[attempt.failureCode]++; continue; }
    const summary = byDirectory.get(attempt.runDirectory)!;
    successfulRuns.push({ runId: summary.runId, manifestSha256: summary.manifestSha256, startedAt: summary.startedAt, completedAt: summary.completedAt });
    if (lastSuccessAt === null || Date.parse(summary.completedAt) > Date.parse(lastSuccessAt)) lastSuccessAt = summary.completedAt;
    for (const item of summary.items) {
      const interval = publicationInterval(item.publicationTime);
      const previous = groups.get(item.sourceItemId);
      const prepublication = interval !== null && Date.parse(item.acquiredAt) < interval.start;
      if (previous === undefined) {
        groups.set(item.sourceItemId, {
          nativeIdentity: item.nativeIdentity, firstSeenAt: item.acquiredAt, sourceRunIds: new Set([summary.runId]),
          interval, unresolved: interval === null, conflict: prepublication,
        });
      } else {
        if (prepublication) previous.conflict = true;
        if (Date.parse(item.acquiredAt) < Date.parse(previous.firstSeenAt)) previous.firstSeenAt = item.acquiredAt;
        previous.sourceRunIds.add(summary.runId);
        if (interval === null) previous.unresolved = true;
        else if (previous.interval === null) previous.interval = interval;
        else {
          if (interval.start !== previous.interval.start) previous.conflict = true;
          previous.interval = { start: previous.interval.start, end: Math.max(previous.interval.end, interval.end) };
        }
      }
    }
  }
  const reasons = new Set<string>();
  if (audit.coverage.status === 'incomplete') reasons.add('audit-declared-incomplete');
  if (Date.parse(audit.observedAt) < end) reasons.add('audit-observed-before-window-end');
  const counts: QzoneAuditLedger['counts'] = {
    auditedItems: audit.items.length, knownInWindow: 0, unresolvedAuditTimes: 0, capturedKnown: 0, missingKnown: 0,
    capturedPartial: 0, timeConflicts: 0, unauditedAcquired: 0, outOfWindowAcquired: 0,
    actionableYes: 0, actionableNo: 0, actionableUnknown: 0,
  };
  const auditedIds = new Set<string>();
  let capturedActionable = 0;
  const items: QzoneAuditLedger['items'] = audit.items.map((item) => {
    const id = sourceItemId(audit.publisherIdentity, item.nativeIdentity);
    auditedIds.add(id);
    const interval = publicationInterval(item.publicationTime);
    const windowMembership = membership(interval, start, end) === 'inside' ? 'inside' : 'uncertain';
    if (windowMembership === 'inside') counts.knownInWindow++;
    else { counts.unresolvedAuditTimes++; reasons.add('audit-time-unresolved'); }
    if (item.actionable === 'yes') counts.actionableYes++;
    else if (item.actionable === 'no') counts.actionableNo++;
    else counts.actionableUnknown++;
    const group = groups.get(id);
    if (group !== undefined) {
      counts.capturedPartial++;
      if (interval !== null && group.interval !== null &&
          (group.interval.start < interval.start || group.interval.end > interval.end)) group.conflict = true;
    }
    let captureStatus: QzoneAuditLedger['items'][number]['captureStatus'];
    if (group?.conflict) captureStatus = 'time-conflict';
    else if (windowMembership === 'uncertain' || group?.unresolved) captureStatus = 'unknown';
    else if (group === undefined) { captureStatus = 'missing'; counts.missingKnown++; }
    else {
      captureStatus = 'captured'; counts.capturedKnown++;
      if (item.actionable === 'yes') capturedActionable++;
    }
    const firstSeenAt = group?.firstSeenAt ?? null;
    const lag = firstSeenAt === null || interval === null ? null : Date.parse(firstSeenAt) - interval.start;
    return {
      nativeIdentity: item.nativeIdentity, sourceItemId: id, publicationTime: item.publicationTime, actionable: item.actionable,
      windowMembership, captureStatus, contentCompleteness: group === undefined ? 'not-acquired' : 'partial',
      firstSeenAt, sourceRunIds: group === undefined ? [] : [...group.sourceRunIds],
      acquisitionLagMs: captureStatus === 'captured' && (item.publicationTime.precision === 'second' || item.publicationTime.precision === 'millisecond') && lag !== null && lag >= 0 ? lag : null,
    };
  });
  const unauditedItems: QzoneAuditLedger['unauditedItems'] = [];
  let lastNewItemObservedAt: string | null = null;
  for (const [id, group] of groups) {
    if (lastNewItemObservedAt === null || Date.parse(group.firstSeenAt) > Date.parse(lastNewItemObservedAt)) lastNewItemObservedAt = group.firstSeenAt;
    if (group.conflict) { counts.timeConflicts++; reasons.add('publication-time-conflict'); }
    if (group.unresolved) reasons.add('acquisition-time-unresolved');
    if (group.conflict || group.unresolved) continue;
    const acquiredMembership = membership(group.interval, start, end);
    if (acquiredMembership === 'uncertain') reasons.add('acquisition-time-unresolved');
    if (acquiredMembership === 'outside') counts.outOfWindowAcquired++;
    else if (acquiredMembership === 'inside' && !auditedIds.has(id)) {
      unauditedItems.push({ nativeIdentity: group.nativeIdentity, sourceItemId: id, firstSeenAt: group.firstSeenAt, sourceRunIds: [...group.sourceRunIds] });
      counts.unauditedAcquired++;
      reasons.add('unlisted-acquired-posts');
    }
  }
  const coverageReasons = [...reasons];
  const actionableReasons = counts.actionableUnknown > 0 ? [...coverageReasons, 'actionable-labels-unresolved'] : coverageReasons;
  return {
    schemaVersion: 1, kind: 'qzone-manual-audit',
    source: {
      sourceId: policy.source.sourceId, publisherIdentity: policy.source.publisherIdentity, role: policy.source.role,
      policyVersion: policy.source.policyVersion, policySha256: qzonePolicySha256(policy),
    },
    window: audit.window, captureCutoffAt: observations.captureCutoffAt,
    audit: {
      method: audit.method, auditor: audit.auditor, observedAt: audit.observedAt, publicAudienceEvidence: audit.publicAudienceEvidence,
      declaredCoverage: audit.coverage, effectiveCoverage: coverageReasons.length === 0 ? 'complete' : 'incomplete',
      limitationCodes: actionableReasons,
    },
    counts,
    observations: {
      declaredAttemptCount: observations.attempts.length, verifiedSuccessCount: successfulRuns.length,
      declaredFailureCount: observations.attempts.length - successfulRuns.length,
      // Every completed acquisition still uses first-page-only discovery, including empty successes.
      incompleteSuccessCount: successfulRuns.length, firstAttemptAt, lastAttemptAt, lastSuccessAt, lastNewItemObservedAt,
      failureCounts, successfulRuns,
    },
    items, unauditedItems,
    rates: {
      postIdentityCapture: rate(counts.capturedKnown, counts.knownInWindow, coverageReasons),
      actionablePostCapture: rate(capturedActionable, counts.actionableYes, actionableReasons),
    },
    publicationEligible: false, bundleEligible: false, benchmarkStarted: false,
  };
}
