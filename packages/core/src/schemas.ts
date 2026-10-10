import { z } from 'zod';

const sourceIdSchema = z
  .string()
  .min(3)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'source id must be kebab-case');

const organizationKindSchema = z.enum([
  'university',
  'academic-unit',
  'administrative-unit',
  'service-unit',
  'student-organization',
  'other',
]);

const classificationValueSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'classification values must be lowercase kebab-case',
  );

const classificationValuesSchema = z
  .array(classificationValueSchema)
  .min(1)
  .refine(
    (values) => new Set(values).size === values.length,
    'classification values must be unique',
  );

const sourceClassificationSchema = z
  .object({
    audiences: classificationValuesSchema.optional(),
    topics: classificationValuesSchema.optional(),
  })
  .strict()
  .refine(
    ({ audiences, topics }) => audiences !== undefined || topics !== undefined,
    'classification must define audiences or topics',
  );

const sourceBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: sourceIdSchema,
  name: z.string().min(1),
  organization: z
    .object({
      id: sourceIdSchema,
      name: z.string().min(1),
      kind: organizationKindSchema.optional(),
    })
    .strict(),
  classification: sourceClassificationSchema.optional(),
  url: z.url(),
}).strict();

const webPlusSelectorsSchema = z.object({
  listItem: z.string().min(1).optional(),
  listLink: z.string().min(1).optional(),
  listPublishedAt: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  publishedAt: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
}).strict();

const boshanSelectorsSchema = z.object({
  content: z.string().min(1),
}).strict();

const jobPortalInformationTypeSchema = z.enum([
  'NEWS',
  'COLLEGE',
  'GUIDE',
]);

export const webPlusSourceConfigSchema = sourceBaseSchema.extend({
  adapter: z.object({
    type: z.literal('webplus'),
    selectors: webPlusSelectorsSchema.optional(),
  }).strict(),
});

export const boshanSourceConfigSchema = sourceBaseSchema.extend({
  adapter: z.object({
    type: z.literal('boshan'),
    channelId: z.number().int().positive(),
    pageSize: z.number().int().positive().max(100),
    selectors: boshanSelectorsSchema,
  }).strict(),
});

export const jobPortalInformationSourceConfigSchema = sourceBaseSchema.extend({
  adapter: z.object({
    type: z.literal('job-portal-information'),
    contentType: jobPortalInformationTypeSchema,
    pageSize: z.number().int().positive().max(100),
  }).strict(),
});

export const jobPortalRecruitmentSourceConfigSchema = sourceBaseSchema.extend({
  adapter: z.object({
    type: z.literal('job-portal-recruitment'),
    pageSize: z.number().int().positive().max(100),
  }).strict(),
});

export const sourceConfigSchema = z.union([
  webPlusSourceConfigSchema,
  boshanSourceConfigSchema,
  jobPortalInformationSourceConfigSchema,
  jobPortalRecruitmentSourceConfigSchema,
]);

export function parseSourceConfig(input: unknown): SourceConfig {
  return sourceConfigSchema.parse(input);
}

export type WebPlusSourceConfig = z.infer<typeof webPlusSourceConfigSchema>;
export type BoshanSourceConfig = z.infer<typeof boshanSourceConfigSchema>;
export type JobPortalInformationSourceConfig = z.infer<
  typeof jobPortalInformationSourceConfigSchema
>;
export type JobPortalRecruitmentSourceConfig = z.infer<
  typeof jobPortalRecruitmentSourceConfigSchema
>;
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export function isBoshanSourceConfig(
  source: SourceConfig,
): source is BoshanSourceConfig {
  return source.adapter.type === 'boshan';
}

export function isJobPortalInformationSourceConfig(
  source: SourceConfig,
): source is JobPortalInformationSourceConfig {
  return source.adapter.type === 'job-portal-information';
}

export function isJobPortalRecruitmentSourceConfig(
  source: SourceConfig,
): source is JobPortalRecruitmentSourceConfig {
  return source.adapter.type === 'job-portal-recruitment';
}

