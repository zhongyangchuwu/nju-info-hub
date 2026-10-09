import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersistedSourceSummary, SourceEntryQueryResult } from "@nju-info/db";
import { buildAtomBundle, buildJsonBundle, buildRssBundle } from "./bundle.js";
import { exportFeeds, type FeedExportReader } from "./export-feeds.js";
import { buildJsonFeed } from "./feed.js";
import { buildSourceCatalog, resolveSourceSet } from "./source-set.js";
import { buildAtomFeed, buildRssFeed } from "./xml-feeds.js";

type SocialMetadata = NonNullable<SourceEntryQueryResult["social"]>;
type PublicationTime = SocialMetadata["publicationTime"];
const publisher: SocialMetadata["publisherIdentity"] = { scheme: "qzone-uin", version: 1, value: "123456" };
const native: SocialMetadata["nativeIdentity"] = { scheme: "qzone-tid", version: 1, tid: "native-post" };
const nativeId = "social-native-v1:" + createHash("sha256")
  .update(JSON.stringify(["social-native", 1, "qzone", publisher, native])).digest("hex");
const source: PersistedSourceSummary = {
  id: "synthetic-relay", name: "Synthetic relay publisher",
  organization: { id: "synthetic", name: "Synthetic organization, not the author" },
  url: "https://example.org/relay",
  socialPublication: { status: "active", changedAt: "2026-09-24T10:00:00.100Z" },
};
const second: PublicationTime = {
  original: { value: "2026-09-23T18:04:37+08:00", representation: "iso8601" },
  precision: "second", timezone: "Asia/Shanghai", normalizedAt: "2026-09-23T10:04:37.000Z", publishedOn: "2026-09-23",
};
function entry(publicationTime: PublicationTime = second): SourceEntryQueryResult {
  return {
    sourceId: source.id, sourceItemId: nativeId, sourceName: source.name, organization: source.organization,
    contentStatus: "link-only", acquisitionKind: "external-public", noticeRevisionNumber: null, observationRevisionNumber: 1,
    title: "Synthetic relayed item", url: "https://example.org/post?id=1",
    publishedAtRaw: publicationTime.original?.value ?? null, publishedOn: publicationTime.publishedOn,
    bodyText: "", bodyHtml: "", attachments: [],
    provenance: { fetchedAt: "2026-09-24T10:00:00.100Z", contentSha256: "a".repeat(64) },
    modifiedAt: "2026-09-24T10:00:00.100Z",
    social: {
      platform: "qzone", publisherIdentity: publisher, nativeIdentity: native, role: "relay", publicationTime,
      attribution: { relationship: "unknown", verification: "unknown", origin: null,
        evidence: [{ kind: "operator-review", description: "PRIVATE OPERATOR REVIEW", url: null, blobSha256: null }] },
      policyVersion: "synthetic-policy-v1", revisionNumber: 1,
    },
  };
}

const timeCases: { name: string; time: PublicationTime; transport?: string }[] = [
  { name: "second", time: second, transport: second.normalizedAt! },
  { name: "minute", time: { ...second, original: { value: "2026-09-23T18:04+08:00", representation: "iso8601" },
    precision: "minute", normalizedAt: "2026-09-23T10:04:00.000Z" }, transport: "2026-09-23T10:04:00.000Z" },
  { name: "millisecond", time: { ...second, original: { value: "2026-09-23T18:04:37.123+08:00", representation: "iso8601" },
    precision: "millisecond", normalizedAt: "2026-09-23T10:04:37.123Z" }, transport: "2026-09-23T10:04:37.123Z" },
  { name: "day", time: { original: { value: "2026-09-23", representation: "iso8601" },
    precision: "day", timezone: null, normalizedAt: null, publishedOn: "2026-09-23" }, transport: "2026-09-23T12:00:00Z" },
  { name: "unknown", time: { original: { value: "recently", representation: "text" },
    precision: "unknown", timezone: null, normalizedAt: null, publishedOn: null } },
];

describe("social publication serializers", () => {
  it.each(timeCases)("preserves $name native precision in individual and combined feeds", ({ time, transport }) => {
    const current = entry(time);
    const set = resolveSourceSet({ id: "synthetic", title: "Synthetic set", sourceIds: [source.id] }, [source]);
    const parts = [{ source, entries: [current] }];
    for (const feed of [buildJsonFeed(source, [current]), buildJsonBundle(set, parts)]) {
      const item = feed.items[0]!;
      if (transport === undefined) expect(item).not.toHaveProperty("date_published");
      else expect(item.date_published).toBe(transport);
      expect(item._nju.social?.publication_time).toEqual(time);
      expect(item._nju.social).toMatchObject({ role: "relay", publisher_identity: publisher, native_identity: native,
        policy_version: "synthetic-policy-v1", revision_number: 1,
        attribution: { relationship: "unknown", verification: "unknown", origin: null } });
      if (time.publishedOn !== null) expect(item._nju.date_precision).toBe(time.precision);
      else expect(item._nju).not.toHaveProperty("published_on");
      expect(item.content_text).toContain("Relayed publication");
      expect(item.content_text).toContain("Original authorship is unknown");
      expect(item).not.toHaveProperty("content_html");
      expect(item).not.toHaveProperty("attachments");
      expect(JSON.stringify(feed)).not.toContain("PRIVATE OPERATOR REVIEW");
      expect(item._nju.social?.attribution).not.toHaveProperty("evidence");
    }
    for (const atom of [buildAtomFeed(source, [current]), buildAtomBundle(set, parts)]) {
      if (transport === undefined) expect(atom).not.toContain("<published>");
      else expect(atom).toContain(`<published>${transport}</published>`);
      expect(atom).toContain(`<nju:precision>${time.precision}</nju:precision>`);
      expect(atom).toContain('<nju:publisher_identity scheme="qzone-uin" version="1">123456</nju:publisher_identity>');
      expect(atom).toContain('<nju:native_identity scheme="qzone-tid" version="1">');
      expect(atom).toContain('<nju:attribution relationship="unknown" verification="unknown">');
      expect(atom).toContain("<name>Original author unknown</name>");
      expect(atom).not.toContain(`<name>${source.organization.name}</name>`);
      expect(atom).not.toContain("PRIVATE OPERATOR REVIEW");
      if (time.normalizedAt !== null) expect(atom).toContain(`<nju:normalized_at>${time.normalizedAt}</nju:normalized_at>`);
    }
    for (const rss of [buildRssFeed(source, [current]), buildRssBundle(set, parts)]) {
      if (transport === undefined) expect(rss).not.toContain("<pubDate>");
      else expect(rss).toContain(`<pubDate>${new Date(transport).toUTCString()}</pubDate>`);
      expect(rss).toContain(`<nju:precision>${time.precision}</nju:precision>`);
      expect(rss).toContain("Relayed publication");
      expect(rss).not.toContain("PRIVATE OPERATOR REVIEW");
      if (time.normalizedAt !== null) expect(rss).toContain(`<nju:normalized_at>${time.normalizedAt}</nju:normalized_at>`);
    }
  });

  it("retains native feed identity while correcting content and modification metadata", () => {
    const initial = entry();
    const corrected: SourceEntryQueryResult = { ...initial, title: "Corrected title", url: "https://example.org/post?id=2",
      provenance: { fetchedAt: initial.provenance.fetchedAt, contentSha256: "b".repeat(64) },
      modifiedAt: "2026-09-24T10:00:00.200Z",
      social: { ...initial.social!, revisionNumber: 2 } };
    const before = buildJsonFeed(source, [initial]).items[0]!;
    const after = buildJsonFeed(source, [corrected]).items[0]!;
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ title: "Corrected title", url: corrected.url, date_published: second.normalizedAt,
      date_modified: corrected.modifiedAt, _nju: { social: { revision_number: 2 }, content_sha256: "b".repeat(64),
        fetched_at: initial.provenance.fetchedAt } });
    expect(buildAtomFeed(source, [corrected])).toContain(`<id>${after.id}</id>`);
    expect(buildAtomFeed(source, [corrected])).toContain(`<updated>${corrected.modifiedAt}</updated>`);
    expect(buildRssFeed(source, [corrected])).toContain(`<guid isPermaLink="false">${after.id}</guid>`);
  });

  it("exposes reported relay origins without turning the publisher into the original author", () => {
    const current = entry();
    current.social!.attribution = { relationship: "relay", verification: "reported", evidence: [],
      origin: { publisherName: "Reported origin & publisher", publisherId: "origin-publisher", nativeItemId: "original-item",
        url: "https://example.org/original?id=1" } };
    const item = buildJsonFeed(source, [current]).items[0]!;
    expect(item._nju.social?.attribution.origin).toEqual(current.social!.attribution.origin);
    const atom = buildAtomFeed(source, [current]);
    expect(atom).toContain("<name>Original author unknown</name>");
    expect(atom).toContain('<nju:attribution relationship="relay" verification="reported">');
    expect(atom).toContain("<nju:publisher_name>Reported origin &amp; publisher</nju:publisher_name>");
    expect(atom).not.toContain(`<name>${source.name}</name>`);
  });

  it.each(["revoked", "expired"] as const)("serializes retained %s source metadata with stable empty feeds", (status) => {
    const withdrawn: PersistedSourceSummary = { ...source,
      socialPublication: { status, changedAt: "2026-09-24T10:00:00.300Z" } };
    const json = buildJsonFeed(withdrawn, []);
    expect(json.items).toEqual([]);
    expect(json._nju.social_publication).toEqual({ status, changed_at: withdrawn.socialPublication!.changedAt });
    const atom = buildAtomFeed(withdrawn, []);
    const rss = buildRssFeed(withdrawn, []);
    expect(atom).toContain(`<nju:social_publication status="${status}" changed_at="2026-09-24T10:00:00.300Z"/>`);
    expect(atom).toContain("<updated>2026-09-24T10:00:00.300Z</updated>");
    expect(atom).not.toContain("<entry>");
    expect(rss).toContain(`<nju:social_publication status="${status}"`);
    expect(rss).not.toContain("<item>");
    expect(buildAtomFeed(withdrawn, [], { generatedAt: "2026-09-25T12:00:00Z" })).toBe(atom);
    expect(buildSourceCatalog([withdrawn], new URL("https://example.org/"))).toMatchObject({
      sources: [{ id: source.id, social_publication: { status } }],
    });
  });

  it.each(["suppression", "mixed-revocation", "empty-revocation"] as const)("retains the source lifecycle clock in %s set feeds", (transition) => {
    const changedAt = "2026-09-24T10:00:01.300Z";
    const changed: PersistedSourceSummary = { ...source,
      socialPublication: { status: transition === "suppression" ? "active" : "revoked", changedAt } };
    const { socialPublication: _publication, ...website } = source;
    const oldWebsite: PersistedSourceSummary = { ...website, id: "old-website" };
    const oldEntry = entry();
    oldEntry.sourceId = oldWebsite.id;
    delete oldEntry.social;
    delete oldEntry.modifiedAt;
    const parts = transition === "mixed-revocation"
      ? [{ source: changed, entries: [] }, { source: oldWebsite, entries: [oldEntry] }]
      : [{ source: changed, entries: transition === "suppression" ? [entry()] : [] }];
    const sources = parts.map((part) => part.source);
    const set = resolveSourceSet({ id: "synthetic", title: "Synthetic set", sourceIds: sources.map((item) => item.id) }, sources);
    const first = { generatedAt: "2026-09-25T00:00:00Z" };
    const second = { generatedAt: "2026-09-26T00:00:00Z" };
    const atom = buildAtomBundle(set, parts, first);
    const rss = buildRssBundle(set, parts, first);
    expect(atom).toContain(`<updated>${changedAt}</updated>`);
    expect(rss).toContain(`<lastBuildDate>${new Date(changedAt).toUTCString()}</lastBuildDate>`);
    expect(buildAtomBundle(set, parts, second)).toBe(atom);
    expect(buildRssBundle(set, parts, second)).toBe(rss);
  });

  it("replaces all static source and set outputs after withdrawal using the existing publication transaction", async () => {
    let publishedSource = source;
    let entries = [entry()];
    const reader: FeedExportReader = { listSources: () => [publishedSource], listRecentSourceEntries: () => entries };
    const directory = mkdtempSync(join(tmpdir(), "nju-info-social-feed-"));
    const options = { publicBaseUrl: "https://example.org/", sourceSet: { id: "synthetic", title: "Synthetic set", sourceIds: [source.id] } };
    try {
      await exportFeeds(reader, directory, [source.id], options);
      for (const format of ["json", "atom", "rss"]) {
        expect(readFileSync(join(directory, "feeds", `${source.id}.${format}`), "utf8")).toContain("Synthetic relayed item");
        expect(readFileSync(join(directory, "bundles", `synthetic.${format}`), "utf8")).toContain("Synthetic relayed item");
      }
      entries = [];
      publishedSource = { ...source, socialPublication: { status: "revoked", changedAt: "2026-09-24T10:00:00.300Z" } };
      await exportFeeds(reader, directory, [source.id], options);
      for (const format of ["json", "atom", "rss"]) {
        for (const path of [join(directory, "feeds", `${source.id}.${format}`), join(directory, "bundles", `synthetic.${format}`)]) {
          const serialized = readFileSync(path, "utf8");
          expect(serialized).not.toContain("Synthetic relayed item");
          expect(serialized).not.toContain("https://example.org/post?id=1");
          expect(serialized).not.toContain(nativeId);
        }
      }
      expect(JSON.parse(readFileSync(join(directory, "feeds", `${source.id}.json`), "utf8")).items).toEqual([]);
      expect(JSON.parse(readFileSync(join(directory, "catalog", "sources.json"), "utf8")).sources[0].social_publication.status).toBe("revoked");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
