import { z } from 'zod';

const sourceIdSchema = z
  .string()
  .min(3)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'source id must be kebab-case');

const sourceBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: sourceIdSchema,
  name: z.string().min(1),
  organization: z.object({
    id: sourceIdSchema,
    name: z.string().min(1),
  }),
  url: z.url(),
  audience: z.array(z.string().min(1)).default([]),
  categories: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true),
  crawl: z
    .object({
      intervalMinutes: z.number().int().positive().optional(),
    })
    .optional(),
});

const webPlusSelectorsSchema = z.object({
  listItem: z.string().min(1).optional(),
  listLink: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  publishedAt: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
});

export const webPlusSourceConfigSchema = sourceBaseSchema.extend({
  adapter: z.object({
    type: z.literal('webplus'),
    selectors: webPlusSelectorsSchema.optional(),
  }),
});

export const rssHubSourceConfigSchema = sourceBaseSchema.extend({
  adapter: z.object({
    type: z.literal('rsshub'),
    route: z.string().min(1).startsWith('/'),
  }),
});

// Zod's discriminatedUnion works on a property of the object itself. Our
// public YAML keeps adapter details nested, so parse the common shape first
// and dispatch explicitly. This also keeps future adapter configs readable.
export function parseSourceConfig(input: unknown): SourceConfig {
  const raw = sourceBaseSchema
    .extend({ adapter: z.object({ type: z.string().min(1) }).passthrough() })
    .parse(input);

  switch (raw.adapter.type) {
    case 'webplus':
      return webPlusSourceConfigSchema.parse(input);
    case 'rsshub':
      return rssHubSourceConfigSchema.parse(input);
    default:
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['adapter', 'type'],
          message: `unsupported adapter type: ${raw.adapter.type}`,
        },
      ]);
  }
}

export type WebPlusSourceConfig = z.infer<typeof webPlusSourceConfigSchema>;
export type RssHubSourceConfig = z.infer<typeof rssHubSourceConfigSchema>;
export type SourceConfig = WebPlusSourceConfig | RssHubSourceConfig;

