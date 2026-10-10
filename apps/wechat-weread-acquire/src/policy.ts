import {
  socialEnvelopePayloadSchema,
  type SocialEnvelopePayload,
} from '@nju-info/core';
import { z } from 'zod';

const nonBlankString = z.string().refine((value) => value.trim().length > 0, 'must not be blank');

function isValidIsoTimestamp(value: string): boolean {
  // JavaScript timestamps cannot compare submillisecond instants without truncation.
  if (/\.\d{4}/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= daysInMonth;
}

const timestampSchema = z.iso.datetime({ offset: true }).refine(isValidIsoTimestamp, 'expected a valid explicit-offset ISO timestamp');

const qualificationSchema = z.object({
  owner: nonBlankString,
  publicAudienceEvidence: nonBlankString,
  allowedContentScope: nonBlankString,
  redistributionBasis: nonBlankString,
  reviewedAt: timestampSchema,
  reviewUntil: timestampSchema,
}).strict();

const sourcePolicySchema = z.object({
  schemaVersion: z.literal(1),
  source: socialEnvelopePayloadSchema.shape.source,
  qualification: qualificationSchema,
}).strict().superRefine((policy, context) => {
  const { source } = policy;
  if (source.platform !== 'wechat') {
    context.addIssue({ code: 'custom', path: ['source', 'platform'], message: 'Weread policies require the wechat platform' });
  }
  if (source.publisherIdentity.scheme !== 'wechat-biz') {
    context.addIssue({ code: 'custom', path: ['source', 'publisherIdentity', 'scheme'], message: 'Weread policies require a wechat-biz publisher identity' });
  }
  if (source.access !== 'credentialed-public') {
    context.addIssue({ code: 'custom', path: ['source', 'access'], message: 'Weread policies require credentialed-public access' });
  }
  if (source.audience !== 'public') {
    context.addIssue({ code: 'custom', path: ['source', 'audience'], message: 'Weread policies require a public audience' });
  }
  if (source.redistributionMode !== 'review-only') {
    context.addIssue({ code: 'custom', path: ['source', 'redistributionMode'], message: 'Weread policies require review-only redistribution' });
  }
  if (source.policyVersion.trim().length === 0) {
    context.addIssue({ code: 'custom', path: ['source', 'policyVersion'], message: 'policyVersion must not be blank' });
  }
});

export type WechatSourcePolicy = {
  schemaVersion: 1;
  source: SocialEnvelopePayload['source'];
  qualification: {
    owner: string;
    publicAudienceEvidence: string;
    allowedContentScope: string;
    redistributionBasis: string;
    reviewedAt: string;
    reviewUntil: string;
  };
};

export function parseWechatSourcePolicy(input: unknown, now: Date = new Date()): WechatSourcePolicy {
  const nowMilliseconds = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMilliseconds)) throw new RangeError('now must be a valid Date');

  const policy = sourcePolicySchema.parse(input);
  const reviewedAt = Date.parse(policy.qualification.reviewedAt);
  const reviewUntil = Date.parse(policy.qualification.reviewUntil);
  const qualificationPath = ['qualification'];
  const issues: z.ZodIssue[] = [];

  if (reviewedAt > nowMilliseconds) {
    issues.push({
      code: 'custom',
      path: [...qualificationPath, 'reviewedAt'],
      message: 'reviewedAt must not be in the future',
    });
  }
  if (reviewUntil <= nowMilliseconds) {
    issues.push({
      code: 'custom',
      path: [...qualificationPath, 'reviewUntil'],
      message: 'reviewUntil must be later than now',
    });
  }
  if (reviewedAt >= reviewUntil) {
    issues.push({
      code: 'custom',
      path: [...qualificationPath, 'reviewUntil'],
      message: 'reviewUntil must be later than reviewedAt',
    });
  }
  if (issues.length > 0) throw new z.ZodError(issues);

  return policy;
}
