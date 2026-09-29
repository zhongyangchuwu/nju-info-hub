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
  title: z.string().min(1).optional(),
  publishedAt: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
}).strict();

export const webPlusSourceConfigSchema = sourceBaseSchema.extend({
  adapter: z.object({
    type: z.literal('webplus'),
    selectors: webPlusSelectorsSchema.optional(),
  }).strict(),
});

export function parseSourceConfig(input: unknown): SourceConfig {
  return webPlusSourceConfigSchema.parse(input);
}

export type WebPlusSourceConfig = z.infer<typeof webPlusSourceConfigSchema>;
export type SourceConfig = WebPlusSourceConfig;

