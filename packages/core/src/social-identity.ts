import { createHash } from 'node:crypto';
import { z } from 'zod';

const decimalIdSchema = z.string().regex(/^[1-9]\d*$/, 'expected canonical positive decimal ID');
const nativeIdSchema = z.string().min(1).refine(
  (value) => !/[\s\u0000-\u001f\u007f]/.test(value),
  'native IDs must not contain whitespace or control characters',
);

const wechatPublisherSchema = z.object({
  scheme: z.literal('wechat-biz'),
  version: z.literal(1),
  value: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(
    (value) => Buffer.from(value, 'base64').toString('base64') === value,
    'expected canonical padded base64 __biz value',
  ),
}).strict();

const qzonePublisherSchema = z.object({
  scheme: z.literal('qzone-uin'),
  version: z.literal(1),
  value: decimalIdSchema,
}).strict();

const wechatArticleSchema = z.object({
  scheme: z.literal('wechat-mid-idx'),
  version: z.literal(1),
  mid: decimalIdSchema,
  idx: z.number().int().positive(),
}).strict();

const qzonePostSchema = z.object({
  scheme: z.literal('qzone-tid'),
  version: z.literal(1),
  tid: nativeIdSchema,
}).strict();

export const socialPublisherIdentitySchema = z.discriminatedUnion('scheme', [wechatPublisherSchema, qzonePublisherSchema]);
export const socialItemIdentitySchema = z.discriminatedUnion('scheme', [wechatArticleSchema, qzonePostSchema]);

export const socialNativeIdentitySchema = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('wechat'), publisher: wechatPublisherSchema, item: wechatArticleSchema }).strict(),
  z.object({ platform: z.literal('qzone'), publisher: qzonePublisherSchema, item: qzonePostSchema }).strict(),
]);

const wechatMessageFieldsSchema = z.object({
  mid: decimalIdSchema.nullable(),
  appmsgid: decimalIdSchema.nullable(),
  idx: z.number().int().positive(),
}).strict().superRefine((fields, context) => {
  if (fields.mid === null && fields.appmsgid === null) {
    context.addIssue({ code: 'custom', path: ['mid'], message: 'missing publication ID is not importable' });
  }
  if (fields.mid !== null && fields.appmsgid !== null && fields.mid !== fields.appmsgid) {
    context.addIssue({ code: 'custom', path: ['appmsgid'], message: 'conflicting publication IDs are not importable' });
  }
}).transform(({ mid, appmsgid, idx }) => ({
  scheme: 'wechat-mid-idx' as const, version: 1 as const, mid: (mid ?? appmsgid)!, idx,
}));

/** appmsgid is eligible only when the exporter established it is the same native mid. */
export function wechatArticleIdentity(fields: z.input<typeof wechatMessageFieldsSchema>): z.infer<typeof wechatArticleSchema> {
  return wechatMessageFieldsSchema.parse(fields);
}

export type SocialNativeIdentity = z.infer<typeof socialNativeIdentitySchema>;

/** Hash only canonical, versioned platform identities, never provider keys or URLs. */
export function socialSourceItemId(identity: unknown): string {
  const value = socialNativeIdentitySchema.parse(identity);
  const hash = createHash('sha256')
    .update(JSON.stringify(['social-native', 1, value.platform, value.publisher, value.item]))
    .digest('hex');
  return `social-native-v1:${hash}`;
}
