import { readFile } from "node:fs/promises";
import { loadSourceDirectory } from "@nju-info/collector";
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

export const instanceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  instance: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
  }).strict(),
  publication: z.object({
    sources: z.array(publishedSourceSchema).min(1),
    sets: z.array(sourceSetSchema),
  }).strict(),
  deployment: z.object({
    mode: z.literal("github-pages"),
    publicBaseUrl: z.url(),
    schedule: z.string().min(1),
  }).strict(),
  storage: z.object({
    mode: z.enum(["cache-only", "optional-webdav"]),
  }).strict(),
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
  const parsed = instanceConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const registered = new Set((await loadSourceDirectory(sourceDirectory)).map((source) => source.id));

  const publishedIds = parsed.publication.sources.map((source) => source.id);
  assertUnique(publishedIds, "published source id");
  for (const id of publishedIds) {
    if (!registered.has(id)) throw new Error(`unknown published source id: ${id}`);
  }

  assertUnique(parsed.publication.sets.map((set) => set.id), "source set id");
  const published = new Set(publishedIds);
  for (const set of parsed.publication.sets) {
    assertUnique(set.sources, `source id in set ${set.id}`);
    for (const id of set.sources) {
      if (!published.has(id)) {
        throw new Error(`source set ${set.id} references unpublished source id: ${id}`);
      }
    }
  }

  return parsed;
}
