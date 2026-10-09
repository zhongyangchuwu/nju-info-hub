import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { InfoHubDatabaseReader, PersistedSourceSummary, SourceEntryQueryResult } from "@nju-info/db";
import { createApiServer } from "./server.js";

type Reader = Pick<InfoHubDatabaseReader,
  "listSources" | "listOrganizations" | "listRecentNotices" | "listRecentSourceEntries"
  | "listCollectionRuns" | "listCollectionSourceStatuses">;
type SocialMetadata = NonNullable<SourceEntryQueryResult["social"]>;
const publisher: SocialMetadata["publisherIdentity"] = { scheme: "qzone-uin", version: 1, value: "123456" };
const source: PersistedSourceSummary = {
  id: "synthetic-relay", name: "Synthetic relay publisher",
  organization: { id: "synthetic", name: "Synthetic organization, not the author" },
  url: "https://example.org/relay",
  socialPublication: { status: "active", changedAt: "2026-09-24T10:00:00.200Z" },
};
function entry(tid: string, modifiedAt: string): SourceEntryQueryResult {
  const native: SocialMetadata["nativeIdentity"] = { scheme: "qzone-tid", version: 1, tid };
  const sourceItemId = "social-native-v1:" + createHash("sha256")
    .update(JSON.stringify(["social-native", 1, "qzone", publisher, native])).digest("hex");
  return {
    sourceId: source.id, sourceItemId, sourceName: source.name, organization: source.organization,
    contentStatus: "link-only", acquisitionKind: "external-public", noticeRevisionNumber: null, observationRevisionNumber: 1,
    title: `Synthetic ${tid} item`, url: `https://example.org/post?id=${tid}`,
    publishedAtRaw: "2026-09-23T18:04:37+08:00", publishedOn: "2026-09-23", bodyText: "", bodyHtml: "", attachments: [],
    provenance: { fetchedAt: "2026-09-24T09:00:00.000Z", contentSha256: "a".repeat(64) }, modifiedAt,
    social: {
      platform: "qzone", publisherIdentity: publisher, nativeIdentity: native, role: "relay",
      publicationTime: { original: { value: "2026-09-23T18:04:37+08:00", representation: "iso8601" },
        precision: "second", timezone: "Asia/Shanghai", normalizedAt: "2026-09-23T10:04:37.000Z", publishedOn: "2026-09-23" },
      attribution: { relationship: "unknown", verification: "unknown", origin: null, evidence: [] },
      policyVersion: "synthetic-policy-v1", revisionNumber: 1,
    },
  };
}
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve()));
  }
});
async function serving(reader: Reader): Promise<string> {
  const server = createApiServer(reader);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

describe("social public API boundary", () => {
  it.each(["json", "atom", "rss"] as const)("uses the current %s representation for same-second corrections and withdrawals", async (format) => {
    let currentSource = source;
    const older = entry("older", "2026-09-24T10:00:00.100Z");
    const newest = entry("newest", "2026-09-24T10:00:00.200Z");
    let entries: SourceEntryQueryResult[] = [newest, older];
    const reader: Reader = {
      listCollectionRuns: () => [], listCollectionSourceStatuses: () => [],
      listSources: () => [currentSource], listOrganizations: () => [source.organization], listRecentNotices: () => [],
      listRecentSourceEntries: (options = {}) => options.sourceId === source.id ? entries.slice(0, options.limit ?? 50) : [],
    };
    const base = await serving(reader);
    const url = `${base}/feeds/${source.id}.${format}`;
    const initial = await fetch(url);
    expect(initial.status).toBe(200);
    const etag = initial.headers.get("etag")!;
    const lastModified = initial.headers.get("last-modified")!;
    expect(lastModified).toBe(new Date("2026-09-24T10:00:00Z").toUTCString());
    const initialBody = await initial.text();
    expect(initialBody).toContain("Synthetic newest item");
    expect(initialBody).toContain("Relayed publication");
    expect(initialBody).toContain("Original authorship is unknown");
    expect(initialBody).not.toContain("2026-09-23T12:00:00Z");
    if (format === "json") {
      const item = JSON.parse(initialBody).items[0];
      expect(item).toMatchObject({ date_published: "2026-09-23T10:04:37.000Z", date_modified: newest.modifiedAt,
        _nju: { fetched_at: "2026-09-24T09:00:00.000Z", social: { role: "relay", native_identity: { tid: "newest" },
          attribution: { relationship: "unknown", verification: "unknown", origin: null }, revision_number: 1 } } });
      expect(item).not.toHaveProperty("content_html");
      expect(item).not.toHaveProperty("attachments");
    } else {
      expect(initialBody).toContain("<nju:precision>second</nju:precision>");
      expect(initialBody).toContain('<nju:attribution relationship="unknown" verification="unknown">');
      expect(initialBody).toContain("<nju:normalized_at>2026-09-23T10:04:37.000Z</nju:normalized_at>");
      if (format === "atom") expect(initialBody).toContain("<name>Original author unknown</name>");
    }
    const cached = await fetch(url, { headers: { "If-None-Match": `W/${etag}` } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    const imsOnly = await fetch(url, { headers: { "If-Modified-Since": lastModified } });
    expect(imsOnly.status).toBe(200);
    await imsOnly.text();

    const corrected: SourceEntryQueryResult = { ...newest, title: "Corrected newest title", url: "https://example.org/post?id=corrected",
      modifiedAt: "2026-09-24T10:00:00.250Z", social: { ...newest.social!, revisionNumber: 2 },
      provenance: { ...newest.provenance, contentSha256: "b".repeat(64) } };
    entries = [corrected, older];
    currentSource = { ...source, socialPublication: { status: "active", changedAt: corrected.modifiedAt! } };
    const correction = await fetch(url, { headers: { "If-None-Match": etag, "If-Modified-Since": lastModified } });
    expect(correction.status).toBe(200);
    const correctedEtag = correction.headers.get("etag")!;
    expect(correctedEtag).not.toBe(etag);
    expect(correction.headers.get("last-modified")).toBe(lastModified);
    const correctedBody = await correction.text();
    expect(correctedBody).toContain("Corrected newest title");
    const nativeFeedId = `${source.id}:${encodeURIComponent(newest.sourceItemId)}`;
    expect(initialBody).toContain(nativeFeedId);
    expect(correctedBody).toContain(nativeFeedId);
    if (format === "json") expect(JSON.parse(correctedBody).items[0]._nju.social.revision_number).toBe(2);
    else expect(correctedBody).toContain("<nju:revision_number>2</nju:revision_number>");

    // Suppressing the latest item leaves an older observation: max(fetchedAt) must not authorize a stale 304.
    entries = [older];
    currentSource = { ...source, socialPublication: { status: "active", changedAt: "2026-09-24T10:00:00.300Z" } };
    let remainingEtag = "";
    const staleHeaders: Record<string, string>[] = [
      { "If-None-Match": etag },
      { "If-None-Match": correctedEtag, "If-Modified-Since": lastModified },
      { "If-Modified-Since": lastModified },
      { "If-None-Match": '"wrong-etag"', "If-Modified-Since": "Thu, 24 Sep 2099 10:00:00 GMT" },
    ];
    for (const headers of staleHeaders) {
      const remaining = await fetch(url, { headers });
      expect(remaining.status).toBe(200);
      remainingEtag = remaining.headers.get("etag")!;
      expect(remainingEtag).not.toBe(etag);
      expect(remainingEtag).not.toBe(correctedEtag);
      expect(remaining.headers.get("last-modified")).toBe(lastModified);
      const body = await remaining.text();
      expect(body).toContain("Synthetic older item");
      expect(body).not.toContain("Corrected newest title");
      expect(body).not.toContain("https://example.org/post?id=corrected");
    }
    entries = [];
    currentSource = { ...source, socialPublication: { status: "active", changedAt: "2026-09-24T10:00:00.400Z" } };
    const empty = await fetch(url, { headers: { "If-None-Match": remainingEtag, "If-Modified-Since": lastModified } });
    expect(empty.status).toBe(200);
    const emptyEtag = empty.headers.get("etag")!;
    expect(emptyEtag).not.toBe(remainingEtag);
    const emptyBody = await empty.text();
    expect(emptyBody).not.toContain("Synthetic older item");
    expect(emptyBody).not.toContain("Corrected newest title");
    if (format === "json") expect(JSON.parse(emptyBody).items).toEqual([]);
    else expect(emptyBody).not.toContain(format === "atom" ? "<entry>" : "<item>");

    currentSource = { ...source, socialPublication: { status: "revoked", changedAt: "2026-09-24T10:00:00.500Z" } };
    const revoked = await fetch(url, { headers: { "If-None-Match": emptyEtag, "If-Modified-Since": lastModified } });
    expect(revoked.status).toBe(200);
    const revokedEtag = revoked.headers.get("etag")!;
    expect(revokedEtag).not.toBe(emptyEtag);
    const revokedBody = await revoked.text();
    if (format === "json") expect(JSON.parse(revokedBody)).toMatchObject({ items: [], _nju: { social_publication: { status: "revoked" } } });
    else expect(revokedBody).toContain('<nju:social_publication status="revoked"');
    const stable = await fetch(url, { headers: { "If-None-Match": revokedEtag, "If-Modified-Since": lastModified } });
    expect(stable.status).toBe(304);
    expect(await stable.text()).toBe("");
    const revokedIms = await fetch(url, { headers: { "If-Modified-Since": lastModified } });
    expect(revokedIms.status).toBe(200);
    expect(await revokedIms.text()).toBe(revokedBody);
    expect(await (await fetch(`${base}/v1/sources`)).json()).toMatchObject({ data: [{ id: source.id,
      socialPublication: { status: "revoked", changedAt: "2026-09-24T10:00:00.500Z" } }] });
    expect(await (await fetch(`${base}/v1/notices/recent`)).json()).toEqual({ data: [] });
  });

  it("returns an explicitly expired source and an empty current feed instead of an IMS-only 304", async () => {
    const expired: PersistedSourceSummary = { ...source,
      socialPublication: { status: "expired", changedAt: "2026-09-24T10:00:00.200Z" } };
    const base = await serving({ listSources: () => [expired], listRecentSourceEntries: () => [],
      listOrganizations: () => [source.organization], listRecentNotices: () => [],
      listCollectionRuns: () => [], listCollectionSourceStatuses: () => [] });
    const result = await fetch(`${base}/feeds/${source.id}.json`, { headers: { "If-Modified-Since": "Thu, 24 Sep 2099 10:00:00 GMT" } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ items: [], _nju: { social_publication: { status: "expired" } } });
    expect(await (await fetch(`${base}/v1/sources`)).json()).toMatchObject({ data: [{ socialPublication: { status: "expired" } }] });
  });
});
