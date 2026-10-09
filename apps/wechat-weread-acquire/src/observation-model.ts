import path from 'node:path';
import {
  socialEnvelopePayloadSchema,
  socialItemIdentitySchema,
  socialPublisherIdentitySchema,
  socialSourceItemId,
} from '@nju-info/core';
import { z } from 'zod';
import type { WereadObservationSuccess } from './observation-types.js';

const timestampSchema = z.iso.datetime({ offset: true }).refine(
  (value) => !/\.\d{4}/.test(value) && Number.isFinite(Date.parse(value)),
).transform((value) => new Date(value).toISOString());
const publisherSchema = socialPublisherIdentitySchema.pipe(z.object({
  scheme: z.literal('wechat-biz'),
  version: z.literal(1),
  value: z.string(),
}).strict()).refine((identity) => /^[1-9]\d*$/.test(Buffer.from(identity.value, 'base64').toString('utf8')));
const nativeSchema = socialItemIdentitySchema.pipe(z.object({
  scheme: z.literal('wechat-mid-idx'),
  version: z.literal(1),
  mid: z.string(),
  idx: z.number(),
}).strict());
const runDirectorySchema = z.string().refine(
  (value) => path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value) && path.resolve(value) === value,
);
const observationsSchema = z.object({
  schemaVersion: z.literal(1),
  publisherIdentity: publisherSchema,
  cutoffAt: timestampSchema,
  attempts: z.array(z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('success'), runDirectory: runDirectorySchema }).strict(),
    z.object({ outcome: z.enum(['blocked', 'error', 'empty']), observedAt: timestampSchema }).strict(),
  ])).max(1000),
}).strict();
// Verified WeRead candidates always carry this exact, non-opaque publication evidence.
const publicationTimeSchema = socialEnvelopePayloadSchema.shape.publicationTime.pipe(z.object({
  original: z.object({ value: z.string(), representation: z.literal('unix-seconds') }).strict(),
  precision: z.literal('second'),
  timezone: z.literal('Asia/Shanghai'),
  normalizedAt: timestampSchema,
  publishedOn: z.iso.date(),
}).strict());
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const successSchema = z.object({
  inputDir: runDirectorySchema,
  runId: z.uuid(),
  manifestSha256: sha256Schema,
  publisherIdentity: publisherSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  acquiredAt: timestampSchema,
  sourceItemId: socialEnvelopePayloadSchema.shape.item.shape.sourceItemId,
  nativeIdentity: nativeSchema,
  publicationTime: publicationTimeSchema,
  contentSha256: sha256Schema,
}).strict();

export type WereadObservations = z.infer<typeof observationsSchema>;
export type WereadObservationOutcome = WereadObservations['attempts'][number]['outcome'];

export interface WereadObservationLedger {
  schemaVersion: 1;
  kind: 'weread-observation';
  source: {
    publisherIdentity: WereadObservations['publisherIdentity'];
    provider: { name: 'WeRSS'; mode: 'weread_mp' };
  };
  cutoffAt: string;
  evidenceTier: 'restricted';
  publicationEligible: false;
  bundleEligible: false;
  benchmarkStarted: false;
  discovery: { complete: false; reason: 'weread-cover-latest-only' };
  scope: { successes: 'supplied-runs-only'; failures: 'operator-declared-failures' };
  counts: {
    successfulRuns: number;
    blockedAttempts: number;
    errorAttempts: number;
    emptyAttempts: number;
    distinctNativeItems: number;
    duplicateSightings: number;
    publicationConflicts: number;
  };
  items: Array<{
    sourceItemId: string;
    nativeIdentity: WereadObservationSuccess['nativeIdentity'];
    firstSeenAt: string;
    lastSeenAt: string;
    sightingCount: number;
    contentSha256s: string[];
    contentVariantCount: number;
    publicationTimes: string[];
    publicationConflict: boolean;
  }>;
  lastObservation: { observedAt: string; outcomes: WereadObservationOutcome[] } | null;
  lastSuccessAt: string | null;
  progress: {
    kind: 'observed-native-items-only';
    cursor: null;
    coveredThrough: null;
    lastNewNativeItemAt: string | null;
    latestKnownPublication: { publishedAt: string; sourceItemIds: string[] } | null;
    eligible: boolean;
  };
}

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(message);
  return result.data;
}

function clock(now: Date): number {
  const epoch = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(epoch)) throw new Error('Invalid WeRead observation clock');
  return epoch;
}

export function parseWereadObservations(input: unknown, now: Date): WereadObservations {
  const current = clock(now);
  const observations = parse(observationsSchema, input, 'Invalid WeRead observation declaration');
  const cutoff = Date.parse(observations.cutoffAt);
  if (cutoff > current) throw new Error('WeRead observation cutoff is in the future');
  const directories = new Set<string>();
  for (const attempt of observations.attempts) {
    if (attempt.outcome === 'success') {
      if (directories.has(attempt.runDirectory)) throw new Error('Duplicate WeRead success directory');
      directories.add(attempt.runDirectory);
    } else if (Date.parse(attempt.observedAt) > cutoff) {
      throw new Error('WeRead declared observation is after the cutoff');
    }
  }
  return observations;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface NativeSightings {
  sourceItemId: string;
  nativeIdentity: z.infer<typeof nativeSchema>;
  firstSeenAt: string;
  lastSeenAt: string;
  sightingCount: number;
  contentSha256s: Set<string>;
  publicationTimes: Set<string>;
}

/** Supplied restricted evidence only: not a durable checkpoint or publication authority. */
export function buildWereadObservationLedger(
  input: WereadObservations, successes: WereadObservationSuccess[], now: Date,
): WereadObservationLedger {
  // Reparse even typed callers: the ledger is a persisted consumer-safety boundary.
  const observations = parseWereadObservations(input, now);
  const summaries = parse(z.array(successSchema).max(1000), successes, 'Invalid WeRead success summaries');
  const directories = new Set(observations.attempts.flatMap((attempt) =>
    attempt.outcome === 'success' ? [attempt.runDirectory] : []));
  if (summaries.length !== directories.size) {
    throw new Error('WeRead summaries must cover every declared success exactly once');
  }
  const seenDirectories = new Set<string>();
  const runIds = new Set<string>();
  const cutoff = Date.parse(observations.cutoffAt);
  for (const summary of summaries) {
    if (!directories.has(summary.inputDir) || seenDirectories.has(summary.inputDir) || runIds.has(summary.runId)) {
      throw new Error('WeRead success summary has an unexpected or duplicate run');
    }
    if (summary.publisherIdentity.value !== observations.publisherIdentity.value ||
        summary.sourceItemId !== socialSourceItemId({
          platform: 'wechat', publisher: observations.publisherIdentity, item: summary.nativeIdentity,
        })) {
      throw new Error('WeRead success summary has a foreign publisher or native identity');
    }
    const acquired = Date.parse(summary.acquiredAt);
    const started = Date.parse(summary.startedAt);
    const completed = Date.parse(summary.completedAt);
    if (!(Date.parse(summary.publicationTime.normalizedAt) <= acquired &&
        acquired <= started && started <= completed && completed <= cutoff)) {
      throw new Error('Invalid WeRead success clock ordering');
    }
    seenDirectories.add(summary.inputDir);
    runIds.add(summary.runId);
  }
  summaries.sort((left, right) => Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt) ||
    Date.parse(left.completedAt) - Date.parse(right.completedAt) || compareText(left.runId, right.runId));

  const groups = new Map<string, NativeSightings>();
  let lastSuccessAt: string | null = null;
  let lastNewNativeItemAt: string | null = null;
  let lastObservation: { observedAt: string; outcomes: WereadObservationOutcome[] } | null = null;
  function observe(observedAt: string, outcome: WereadObservationOutcome): void {
    const epoch = Date.parse(observedAt);
    const previous = lastObservation === null ? -Infinity : Date.parse(lastObservation.observedAt);
    if (epoch > previous) lastObservation = { observedAt, outcomes: [outcome] };
    else if (epoch === previous && lastObservation !== null && !lastObservation.outcomes.includes(outcome)) {
      lastObservation.outcomes.push(outcome);
    }
  }
  for (const summary of summaries) {
    observe(summary.acquiredAt, 'success');
    if (lastSuccessAt === null || Date.parse(summary.acquiredAt) > Date.parse(lastSuccessAt)) {
      lastSuccessAt = summary.acquiredAt;
    }
    let group = groups.get(summary.sourceItemId);
    if (group === undefined) {
      group = {
        sourceItemId: summary.sourceItemId,
        nativeIdentity: summary.nativeIdentity,
        firstSeenAt: summary.acquiredAt,
        lastSeenAt: summary.acquiredAt,
        sightingCount: 0,
        contentSha256s: new Set(),
        publicationTimes: new Set(),
      };
      groups.set(summary.sourceItemId, group);
      lastNewNativeItemAt = summary.acquiredAt;
    }
    group.lastSeenAt = summary.acquiredAt;
    group.sightingCount += 1;
    group.contentSha256s.add(summary.contentSha256);
    group.publicationTimes.add(summary.publicationTime.normalizedAt);
  }
  const counts = {
    successfulRuns: summaries.length,
    blockedAttempts: 0,
    errorAttempts: 0,
    emptyAttempts: 0,
    distinctNativeItems: groups.size,
    duplicateSightings: summaries.length - groups.size,
    publicationConflicts: 0,
  };
  for (const attempt of observations.attempts) {
    if (attempt.outcome === 'success') continue;
    observe(attempt.observedAt, attempt.outcome);
    if (attempt.outcome === 'blocked') counts.blockedAttempts += 1;
    else if (attempt.outcome === 'error') counts.errorAttempts += 1;
    else counts.emptyAttempts += 1;
  }
  // observe() mutates via a closure; the explicit annotation also keeps the inferred API stable.
  const latestObservation = lastObservation as { observedAt: string; outcomes: WereadObservationOutcome[] } | null;
  latestObservation?.outcomes.sort(compareText);
  const items = [...groups.values()].sort((left, right) => compareText(left.sourceItemId, right.sourceItemId)).map((group) => {
    const publicationTimes = [...group.publicationTimes].sort((left, right) => Date.parse(left) - Date.parse(right));
    const contentSha256s = [...group.contentSha256s].sort(compareText);
    const publicationConflict = publicationTimes.length > 1;
    if (publicationConflict) counts.publicationConflicts += 1;
    return {
      sourceItemId: group.sourceItemId,
      nativeIdentity: group.nativeIdentity,
      firstSeenAt: group.firstSeenAt,
      lastSeenAt: group.lastSeenAt,
      sightingCount: group.sightingCount,
      contentSha256s,
      contentVariantCount: contentSha256s.length,
      publicationTimes,
      publicationConflict,
    };
  });
  let latestKnownPublication: { publishedAt: string; sourceItemIds: string[] } | null = null;
  if (counts.publicationConflicts === 0) {
    for (const item of items) {
      const publishedAt = item.publicationTimes[0]!;
      if (latestKnownPublication === null || Date.parse(publishedAt) > Date.parse(latestKnownPublication.publishedAt)) {
        latestKnownPublication = { publishedAt, sourceItemIds: [item.sourceItemId] };
      } else if (Date.parse(publishedAt) === Date.parse(latestKnownPublication.publishedAt)) {
        latestKnownPublication.sourceItemIds.push(item.sourceItemId);
      }
    }
    latestKnownPublication?.sourceItemIds.sort(compareText);
  }
  return {
    schemaVersion: 1 as const,
    kind: 'weread-observation' as const,
    source: { publisherIdentity: observations.publisherIdentity, provider: { name: 'WeRSS' as const, mode: 'weread_mp' as const } },
    cutoffAt: observations.cutoffAt,
    evidenceTier: 'restricted' as const,
    publicationEligible: false as const,
    bundleEligible: false as const,
    benchmarkStarted: false as const,
    discovery: { complete: false as const, reason: 'weread-cover-latest-only' as const },
    scope: { successes: 'supplied-runs-only' as const, failures: 'operator-declared-failures' as const },
    counts,
    items,
    lastObservation: latestObservation,
    lastSuccessAt,
    progress: {
      kind: 'observed-native-items-only' as const,
      cursor: null,
      coveredThrough: null,
      lastNewNativeItemAt,
      latestKnownPublication,
      eligible: summaries.length > 0 && counts.publicationConflicts === 0,
    },
  };
}
