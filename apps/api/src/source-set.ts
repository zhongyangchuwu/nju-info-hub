import type { PersistedSourceSummary } from "@nju-info/db";
import { feedSelfUrl, type FeedFormat } from "./syndication.js";

const safeSetId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SourceSetDefinition {
  id: string;
  title: string;
  sourceIds: readonly string[];
}

export interface ResolvedSourceSet {
  id: string;
  title: string;
  sourceIds: string[];
  sources: PersistedSourceSummary[];
}

export function resolveSourceSet(
  definition: SourceSetDefinition,
  publishedSources: readonly PersistedSourceSummary[],
): ResolvedSourceSet {
  if (!safeSetId.test(definition.id)) {
    throw new Error("unsafe source set ID: " + JSON.stringify(definition.id));
  }
  const title = definition.title.trim();
  if (!title) throw new Error("source set title must not be empty");
  if (definition.sourceIds.length === 0) throw new Error("source set must contain at least one source");

  const requested = new Set<string>();
  for (const id of definition.sourceIds) {
    if (requested.has(id)) throw new Error("duplicate source ID in source set: " + id);
    requested.add(id);
  }
  const available = new Set(publishedSources.map((source) => source.id));
  const unknown = definition.sourceIds.filter((id) => !available.has(id));
  if (unknown.length) {
    throw new Error("source set contains unpublished source ID" + (unknown.length === 1 ? "" : "s") + ": " + unknown.join(", "));
  }

  const sources = publishedSources.filter((source) => requested.has(source.id));
  return {
    id: definition.id,
    title,
    sourceIds: sources.map((source) => source.id),
    sources,
  };
}

export function buildSourceCatalog(sources: readonly PersistedSourceSummary[], base: URL) {
  return {
    version: 1,
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      organization: source.organization,
      home_page_url: source.url,
      feeds: {
        json: feedSelfUrl(base, source.id, "json"),
        atom: feedSelfUrl(base, source.id, "atom"),
        rss: feedSelfUrl(base, source.id, "rss"),
      },
    })),
  };
}

export function bundleSelfUrl(base: URL, setId: string, format: FeedFormat): string {
  if (!safeSetId.test(setId)) throw new Error("unsafe source set ID: " + JSON.stringify(setId));
  return new URL("bundles/" + encodeURIComponent(setId) + "." + format, base).href;
}
