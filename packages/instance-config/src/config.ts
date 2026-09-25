import { readFile } from "node:fs/promises";
import { loadSourceDirectory } from "@nju-info/collector";
import { Cron } from "croner";
import { z } from "zod";

const publishedSourceSchema = z.object({
  id: z.string().min(1),
  limit: z.number().int().positive(),
}).strict();

const sourceSetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
  opml: z.string().min(1),
}).strict();

const publicationSelectionSchema = z.object({
  sources: z.array(publishedSourceSchema).min(1),
  sets: z.array(sourceSetSchema).max(1, "instance config currently supports at most one curated source set"),
}).strict();

const collectionSchema = z.object({
  schedule: z.string().min(1),
  timeZone: z.string().min(1),
}).strict().superRefine(({ schedule, timeZone }, ctx) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    ctx.addIssue({ code: "custom", path: ["timeZone"], message: `invalid IANA time zone: ${timeZone}` });
    return;
  }

  let job: Cron | undefined;
  try {
    job = new Cron(schedule, { timezone: timeZone, paused: true });
    job.nextRun();
  } catch {
    ctx.addIssue({ code: "custom", path: ["schedule"], message: `invalid cron schedule: ${schedule}` });
  } finally {
    job?.stop();
  }
});

const instanceIdentitySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
}).strict();

export const instanceConfigSchema = z.object({
  schemaVersion: z.literal(2),
  instance: instanceIdentitySchema,
  publication: publicationSelectionSchema.extend({
    publicBaseUrl: z.url(),
  }),
  collection: collectionSchema,
}).strict();

export type InstanceConfig = z.infer<typeof instanceConfigSchema>;

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

export async function loadInstanceConfig(
  configPath: string,
  sourceDirectory: string,
): Promise<InstanceConfig> {
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const config = instanceConfigSchema.parse(raw);

  const registered = new Set((await loadSourceDirectory(sourceDirectory)).map((source) => source.id));
  const publishedIds = config.publication.sources.map((source) => source.id);
  assertUnique(publishedIds, "published source id");
  for (const id of publishedIds) {
    if (!registered.has(id)) throw new Error(`unknown published source id: ${id}`);
  }

  assertUnique(config.publication.sets.map((set) => set.id), "source set id");
  const published = new Set(publishedIds);
  for (const set of config.publication.sets) {
    assertUnique(set.sources, `source id in set ${set.id}`);
    for (const id of set.sources) {
      if (!published.has(id)) {
        throw new Error(`source set ${set.id} references unpublished source id: ${id}`);
      }
    }
  }

  return config;
}
