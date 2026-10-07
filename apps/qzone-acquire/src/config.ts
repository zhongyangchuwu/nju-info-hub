import { socialEnvelopePayloadSchema } from '@nju-info/core';
import { z } from 'zod';

const policySchema = z.object({
  schemaVersion: z.literal(1),
  source: socialEnvelopePayloadSchema.shape.source,
  qualification: z.object({
    owner: z.string().trim().min(1),
    publicAudienceEvidence: z.string().trim().min(1),
    allowedContentScope: z.string().trim().min(1),
    redistributionBasis: z.string().trim().min(1),
    reviewedAt: z.iso.datetime({ offset: true }),
    reviewUntil: z.iso.datetime({ offset: true }),
  }).strict(),
}).strict();

export type QzonePolicy = z.infer<typeof policySchema>;

export function parseQzonePolicy(input: unknown, now = new Date()): QzonePolicy {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid QZone source policy');
  const policy = parsed.data;
  if (policy.source.platform !== 'qzone' || policy.source.publisherIdentity.scheme !== 'qzone-uin' ||
      policy.source.access !== 'credentialed-public' || policy.source.redistributionMode === 'denied') {
    throw new Error('QZone acquisition requires an allowlisted credentialed-public publisher policy');
  }
  const reviewed = Date.parse(policy.qualification.reviewedAt);
  const expires = Date.parse(policy.qualification.reviewUntil);
  if (reviewed > now.getTime() || reviewed >= expires || expires <= now.getTime()) {
    throw new Error('QZone source qualification is not currently valid');
  }
  return policy;
}

export interface QzoneRuntimeConfig {
  origin: string;
  token: string;
  astrbotVersion: string;
  pluginVersion: string;
}

export function parseQzoneRuntimeConfig(env: NodeJS.ProcessEnv): QzoneRuntimeConfig {
  const origin = env.QZONE_ASTRBOT_URL;
  const token = env.QZONE_ASTRBOT_TOKEN;
  const astrbotVersion = env.QZONE_ASTRBOT_VERSION;
  const pluginVersion = env.QZONE_PLUGIN_VERSION;
  if (!origin || !token || !astrbotVersion?.trim() || !pluginVersion?.trim()) {
    throw new Error('QZONE_ASTRBOT_URL, QZONE_ASTRBOT_TOKEN, QZONE_ASTRBOT_VERSION and QZONE_PLUGIN_VERSION are required');
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Invalid QZONE_ASTRBOT_URL');
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (/[\s\u0000-\u001f\u007f]/.test(origin) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('QZONE_ASTRBOT_URL must be a credential-free HTTPS origin or HTTP loopback origin');
  }
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('Invalid QZONE_ASTRBOT_TOKEN');
  return { origin: url.origin, token, astrbotVersion: astrbotVersion.trim(), pluginVersion: pluginVersion.trim() };
}
