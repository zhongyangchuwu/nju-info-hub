import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  socialEnvelopePayloadSchema,
  socialImportOperationBytes,
  socialProducerReceiptBytes,
  socialPublicationBinding,
  socialSourceItemId,
  socialTrustedSourceSha256,
} from "@nju-info/core";
import type {
  SocialAcquisitionBundle,
  SocialEnvelopePayload,
  SocialImportInput,
  SocialImportOperation,
  SocialImportTrust,
  SocialTrustedSource,
  WebPlusSourceConfig,
} from "@nju-info/core";
import { InfoHubDatabase, InfoHubDatabaseReader } from "./database.js";
import { DATABASE_SCHEMA_VERSION } from "./schema.js";
import { applySocialImport } from "./social-import.js";

const NOW = new Date("2026-10-09T10:00:00.000Z");
const SOURCE: WebPlusSourceConfig = {
  schemaVersion: 1, id: "website-notices", name: "Website notices",
  organization: { id: "test-organization", name: "Synthetic organization" },
  url: "https://example.edu/notices", adapter: { type: "webplus" },
};

interface Fixture {
  producer: KeyObject;
  approver: KeyObject;
  source: SocialTrustedSource;
  trust: SocialImportTrust;
}

interface ItemSpec {
  tid: string;
  title: string;
  publicationTime?: SocialEnvelopePayload["publicationTime"];
}

function fixture(): Fixture {
  const producer = generateKeyPairSync("ed25519");
  const approver = generateKeyPairSync("ed25519");
  const source: SocialTrustedSource = {
    policy: {
      sourceId: "synthetic-social", platform: "qzone",
      publisherIdentity: { scheme: "qzone-uin", version: 1, value: "123456" },
      displayName: "Synthetic relay", role: "relay", access: "credentialed-public",
      audience: "public", redistributionMode: "link-only", policyVersion: "synthetic-v1",
    },
    organization: SOURCE.organization,
    homepageUrl: "https://example.edu/social",
    qualification: {
      owner: "Synthetic operator", publicAudienceEvidence: "Synthetic public audience evidence",
      allowedContentScope: "link-only", redistributionBasis: "Synthetic metadata permission",
      reviewedAt: "2026-10-01T00:00:00.000Z", reviewUntil: "2027-01-01T00:00:00.000Z",
    },
    producerIds: ["synthetic-producer"], approverIds: ["synthetic-approver"],
  };
  return {
    producer: producer.privateKey, approver: approver.privateKey, source,
    trust: {
      schemaVersion: 1,
      producers: [{ id: "synthetic-producer", publicKey: producer.publicKey.export({ type: "spki", format: "der" }).toString("base64") }],
      approvers: [{ id: "synthetic-approver", publicKey: approver.publicKey.export({ type: "spki", format: "der" }).toString("base64") }],
      sources: [source],
    },
  };
}

function itemId(value: Fixture, tid: string): string {
  return socialSourceItemId({
    platform: value.source.policy.platform, publisher: value.source.policy.publisherIdentity,
    item: { scheme: "qzone-tid", version: 1, tid },
  });
}

function input(
  value: Fixture,
  sequence: number,
  items: ItemSpec[] = [{ tid: "post-1", title: "Metadata A" }],
  overrides: Partial<SocialImportOperation> = {},
): SocialImportInput {
  const blobs = new Map<string, Buffer>();
  const envelopes: SocialAcquisitionBundle["envelopes"] = items.map((item) => {
    const nativeIdentity = { scheme: "qzone-tid" as const, version: 1 as const, tid: item.tid };
    const url = `https://example.edu/social/${item.tid}`;
    const metadata = {
      schemaVersion: 1, sanitizationVersion: "qzone-link-metadata-v1", platform: "qzone",
      publisherIdentity: value.source.policy.publisherIdentity,
      item: { nativeIdentity, sourceItemId: itemId(value, item.tid), originalUrl: url, canonicalUrl: url, aliases: [] },
      publicationTime: item.publicationTime ?? {
        original: { value: "2026-10-09T08:00:00+00:00", representation: "iso8601" as const },
        precision: "second" as const, timezone: "UTC", normalizedAt: "2026-10-09T08:00:00.000Z", publishedOn: "2026-10-09",
      },
      content: { title: item.title, text: "", html: "", completeness: "link-only" as const },
      attribution: { relationship: "unknown" as const, verification: "unknown" as const, origin: null, evidence: [] },
    };
    const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    blobs.set(sha256, bytes);
    const payload = socialEnvelopePayloadSchema.parse({
      source: value.source.policy, item: metadata.item, publicationTime: metadata.publicationTime,
      content: metadata.content, media: [], attachments: [], attribution: metadata.attribution,
      rawBlobs: [{
        blob: { sha256, contentType: "application/json; charset=utf-8", byteLength: bytes.length },
        sourceUrl: url, acquiredAt: "2026-10-09T09:00:00.000Z", evidenceTier: "public-safe",
        evidenceKind: "provider-export", sanitizationVersion: "qzone-link-metadata-v1",
      }],
    });
    return {
      schemaVersion: 1, payload,
      provenance: {
        acquiredAt: "2026-10-09T09:00:00.000Z", method: "credentialed-public-export",
        provider: { name: "synthetic-provider", version: "1" }, exporter: { name: "synthetic-exporter", version: "1" }, runId: "synthetic-run",
      },
      // This declaration is intentionally unapproved; only the independent operator signature authorizes it.
      decision: {
        status: "review-required", mode: "none", method: "source-policy",
        policyVersion: value.source.policy.policyVersion, decidedAt: "2026-10-09T09:30:00.000Z",
        reason: "Synthetic pending review", binding: socialPublicationBinding(payload),
      },
    };
  });
  const bundle: SocialAcquisitionBundle = { schemaVersion: 1, bundleId: randomUUID(), envelopes };
  const action = overrides.action ?? "publish";
  const publishing = action === "publish" || action === "restore";
  const bundleBytes = publishing ? Buffer.from(`${JSON.stringify(bundle)}\n`, "utf8") : null;
  const sha256 = bundleBytes === null ? null : createHash("sha256").update(bundleBytes).digest("hex");
  const operation: SocialImportOperation = {
    schemaVersion: 1, operationId: randomUUID(), sourceId: value.source.policy.sourceId,
    sequence, issuedAt: NOW.toISOString(), expiresAt: "2026-10-10T00:00:00.000Z",
    policySha256: socialTrustedSourceSha256(value.source), approverId: "synthetic-approver", action,
    bundle: sha256 === null ? null : {
      sha256, producerId: "synthetic-producer",
      signature: sign(null, socialProducerReceiptBytes("synthetic-producer", sha256), value.producer).toString("base64"),
    },
    sourceItemIds: [], reasonCode: action === "suppress" ? "withdrawal" : action === "revoke-source" ? "source-revocation" : "approved-metadata",
    ...overrides,
  };
  return {
    trust: value.trust,
    authorization: { operation, signature: sign(null, socialImportOperationBytes(operation), value.approver).toString("base64") },
    bundleBytes, blobs: publishing ? blobs : new Map(),
  };
}

function withDatabase(body: (database: InfoHubDatabase, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nju-social-db-"));
  const path = join(directory, "test.sqlite");
  const database = new InfoHubDatabase(path);
  try { body(database, path); } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function ingestWebsite(database: InfoHubDatabase, source: WebPlusSourceConfig = SOURCE): void {
  const body = "<p>Existing website body</p>";
  const sha256 = createHash("sha256").update(body).digest("hex");
  const fetchedAt = "2026-10-09T08:00:00.000Z";
  const url = "https://example.edu/notices/old";
  database.ingestNotice(source, {
    sourceId: source.id, url, fetchedAt, contentType: "text/html", sha256, body,
  }, {
    sourceId: source.id, sourceItemId: "website-old", url, title: "Existing website notice",
    publishedAtRaw: "2026-10-08", publishedOn: "2026-10-08", bodyText: "Existing website body", bodyHtml: body,
    attachments: [], provenance: { fetchedAt, contentSha256: sha256 },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("authenticated social imports", () => {
  it("migrates v5 website history and retains exact signed transport/raw bytes before normalization", () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-social-v5-"));
    const path = join(directory, "test.sqlite");
    let database = new InfoHubDatabase(path);
    try {
      ingestWebsite(database);
      const websiteBefore = database.listRecentNotices();
      database.close();
      using legacy = new DatabaseSync(path);
      legacy.exec(`
        DROP TABLE social_item_suppressions;
        DROP TABLE social_item_publications;
        DROP TABLE social_item_revisions;
        DROP TABLE social_operation_blobs;
        DROP TABLE social_raw_blobs;
        DROP TABLE social_import_operations;
        DROP TABLE social_source_state;
        DROP TABLE collection_source_attempts;
        DROP TABLE collection_runs;
        PRAGMA user_version = 5;
      `);
      database = new InfoHubDatabase(path);
      const value = fixture();
      const packet = input(value, 1);
      expect(database.applySocialImport(packet, NOW)).toMatchObject({ status: "applied", importedItems: 1 });
      expect(database.listRecentNotices()).toEqual(websiteBefore);
      const entry = database.listRecentSourceEntries({ sourceId: value.source.policy.sourceId })[0]!;
      expect(entry).toMatchObject({
        contentStatus: "link-only", acquisitionKind: "external-public", title: "Metadata A",
        bodyText: "", bodyHtml: "", attachments: [], noticeRevisionNumber: null,
        social: { role: "relay", revisionNumber: 1, nativeIdentity: { tid: "post-1" }, attribution: { relationship: "unknown" } },
      });
      expect(entry.provenance.fetchedAt).toBe("2026-10-09T09:00:00.000Z");
      expect(entry.modifiedAt).toBe(NOW.toISOString());
      expect(JSON.stringify(entry)).not.toContain("qualification");
      expect(JSON.stringify(entry)).not.toContain("synthetic-approver");
      using inspection = new DatabaseSync(path, { readOnly: true });
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({ user_version: DATABASE_SCHEMA_VERSION });
      const receipt = inspection.prepare("SELECT authorization_bytes, bundle_bytes FROM social_import_operations").get()!;
      expect(Buffer.from(receipt.bundle_bytes as Uint8Array)).toEqual(packet.bundleBytes);
      expect(Buffer.from(receipt.authorization_bytes as Uint8Array)).toEqual(Buffer.from(`${JSON.stringify(packet.authorization)}\n`));
      const raw = inspection.prepare("SELECT sha256, body FROM social_raw_blobs").get()!;
      expect(Buffer.from(raw.body as Uint8Array)).toEqual(packet.blobs.get(String(raw.sha256)));
      using reader = new InfoHubDatabaseReader(path);
      expect(reader.listRecentSourceEntries()).toEqual(database.listRecentSourceEntries());
      expect(reader.listSources()).toEqual(database.listSources());
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates v6 without recreating social tables or altering website and social records", () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-social-v6-"));
    const path = join(directory, "test.sqlite");
    let database = new InfoHubDatabase(path);
    try {
      ingestWebsite(database);
      const value = fixture();
      const packet = input(value, 1, [{ tid: "one", title: "Retained social entry" },
        { tid: "two", title: "Withdrawn social entry" }]);
      database.applySocialImport(packet, NOW);
      database.applySocialImport(input(value, 2, [], {
        action: "suppress", sourceItemIds: [itemId(value, "two")],
      }), NOW);
      const website = database.listRecentNotices();
      const entries = database.listRecentSourceEntries();
      const sources = database.listSources();
      const stats = database.stats();
      database.close();
      const tables = ["sources", "raw_documents", "source_items", "notice_revisions", "attachments",
        "source_item_observations", "social_source_state", "social_import_operations", "social_raw_blobs",
        "social_operation_blobs", "social_item_revisions", "social_item_publications", "social_item_suppressions"];
      const before = new Map<string, unknown[]>();
      const schemas = new Map<string, unknown>();
      {
        using legacy = new DatabaseSync(path);
        legacy.exec(`DROP TABLE collection_source_attempts; DROP TABLE collection_runs; PRAGMA user_version = 6;`);
        for (const table of tables) {
          before.set(table, legacy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
          schemas.set(table, legacy.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table));
        }
      }
      expect(() => new InfoHubDatabaseReader(path)).toThrow(/schema version 6/);
      database = new InfoHubDatabase(path);
      expect(database.listRecentNotices()).toEqual(website);
      expect(database.listRecentSourceEntries()).toEqual(entries);
      expect(database.listSources()).toEqual(sources);
      expect(database.stats()).toEqual(stats);
      expect(database.listCollectionRuns()).toEqual([]);
      expect(database.listCollectionSourceStatuses()).toEqual([]);
      using inspection = new DatabaseSync(path, { readOnly: true });
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
      for (const table of tables) {
        expect(inspection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(before.get(table));
        expect(inspection.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table)).toEqual(schemas.get(table));
      }
      expect(inspection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const runId = database.beginCollectionRun("manual", NOW.toISOString());
      const attemptId = database.beginCollectionSourceAttempt(runId, SOURCE.id, NOW.toISOString());
      database.finishCollectionSourceAttempt(attemptId, NOW.toISOString(), {
        outcome: "failure", error: { phase: "list-fetch", causes: [{ name: "TypeError" }] },
      });
      expect(database.finishCollectionRun(runId, NOW.toISOString()).outcome).toBe("failure");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects forged authority, altered exact bytes, wrong policy and expired replay without mutations", () => {
    withDatabase((database, path) => {
      const value = fixture();
      const packet = input(value, 1);
      const wrongKeys = fixture();
      const invalid: SocialImportInput[] = [
        { ...packet, trust: { ...value.trust, approvers: wrongKeys.trust.approvers } },
        { ...packet, authorization: {} },
        { ...packet, bundleBytes: Buffer.concat([packet.bundleBytes!, Buffer.from(" ")]) },
        { ...packet, blobs: new Map([...packet.blobs].map(([hash, bytes]) => [hash, Buffer.concat([bytes, Buffer.from(" ")])])) },
        { ...packet, trust: { ...value.trust, sources: [{ ...value.source, homepageUrl: "https://example.edu/changed" }] } },
      ];
      for (const candidate of invalid) {
        expect(() => database.applySocialImport(candidate, NOW)).toThrow();
        expect(database.listSources()).toEqual([]);
        expect(database.listRecentSourceEntries()).toEqual([]);
      }
      database.applySocialImport(packet, NOW);
      using inspection = new DatabaseSync(path, { readOnly: true });
      const before = inspection.prepare("SELECT * FROM social_import_operations").all();
      expect(() => database.applySocialImport(packet, new Date("2026-10-10T00:00:00.000Z"))).toThrow();
      expect(inspection.prepare("SELECT * FROM social_import_operations").all()).toEqual(before);
    });
  });

  it("rolls back source metadata, receipts, raw blobs and identities together on a normalization write failure", () => {
    withDatabase((database, path) => {
      const value = fixture();
      using injection = new DatabaseSync(path);
      injection.exec(`CREATE TRIGGER synthetic_write_failure BEFORE INSERT ON social_item_revisions
        WHEN json_extract(NEW.payload_json, '$.content.title') = 'Fail second item'
        BEGIN SELECT RAISE(ABORT, 'synthetic atomic failure'); END`);
      expect(() => database.applySocialImport(input(value, 1, [
        { tid: "first", title: "Valid first item" }, { tid: "second", title: "Fail second item" },
      ]), NOW)).toThrow("synthetic atomic failure");
      for (const table of ["sources", "social_source_state", "social_import_operations", "social_raw_blobs", "social_operation_blobs", "source_items", "social_item_revisions", "social_item_publications"]) {
        expect(injection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    });
  });

  it("prevents website/social source collisions in both directions without disturbing website history", () => {
    withDatabase((database) => {
      const value = fixture();
      ingestWebsite(database, { ...SOURCE, id: value.source.policy.sourceId });
      const before = database.listRecentNotices();
      expect(() => database.applySocialImport(input(value, 1), NOW)).toThrow("collides");
      expect(database.listRecentNotices()).toEqual(before);
      const other = fixture();
      other.source.policy.sourceId = "another-social";
      database.applySocialImport(input(other, 1), NOW);
      expect(() => database.upsertSource({ ...SOURCE, id: other.source.policy.sourceId })).toThrow("collides");
      expect(() => ingestWebsite(database, { ...SOURCE, id: other.source.policy.sourceId })).toThrow("collides");
      expect(database.listRecentNotices()).toEqual(before);
      expect(database.listRecentSourceEntries({ sourceId: other.source.policy.sourceId })[0]!.social).toBeDefined();
    });
  });

  it("serializes competing website and social registration across the ownership check", () => {
    withDatabase((database, path) => {
      const value = fixture();
      const competing = new DatabaseSync(path, { timeout: 0, enableForeignKeyConstraints: true });
      const packet = input(value, 1);
      let reads = 0;
      let accepted = false;
      let competitionError: unknown;
      const website = { ...SOURCE, id: value.source.policy.sourceId };
      // A stable getter is a deterministic scheduling seam between the real SELECT and INSERT.
      Object.defineProperty(website, "id", { enumerable: true, get() {
        if (++reads === 2) {
          try { applySocialImport(competing, packet, NOW); accepted = true; }
          catch (error) { competitionError = error; }
        }
        return value.source.policy.sourceId;
      } });
      try {
        database.upsertSource(website);
        expect(accepted).toBe(false);
        expect(competitionError).toMatchObject({ errcode: 5 });
        expect(competing.prepare("SELECT adapter_type FROM sources WHERE id = ?").get(value.source.policy.sourceId))
          .toEqual({ adapter_type: "webplus" });
        expect(competing.prepare("SELECT COUNT(*) AS count FROM social_import_operations").get()).toEqual({ count: 0 });
        expect(() => applySocialImport(competing, packet, NOW)).toThrow();
        expect(database.listSources()[0]!.name).toBe(SOURCE.name);
      } finally { competing.close(); }
    });
  });

  it("acknowledges exact old replay after correction, suppression and revocation without changing newer state", () => {
    withDatabase((database, path) => {
      const value = fixture();
      const first = input(value, 1);
      const acknowledgment = { status: "replayed", sourceId: value.source.policy.sourceId, sequence: 1, action: "publish", importedItems: 1, suppressedItems: 0 };
      database.applySocialImport(first, NOW);
      database.applySocialImport(input(value, 2, [{ tid: "post-1", title: "Metadata B" }], { reasonCode: "correction" }), NOW);
      expect(database.applySocialImport(first, NOW)).toEqual(acknowledgment);
      expect(database.listRecentSourceEntries()[0]!.title).toBe("Metadata B");
      database.applySocialImport(input(value, 3, [], { action: "suppress", sourceItemIds: [itemId(value, "post-1")] }), NOW);
      expect(database.applySocialImport(first, NOW)).toEqual(acknowledgment);
      expect(database.listRecentSourceEntries()).toEqual([]);
      database.applySocialImport(input(value, 4, [], { action: "revoke-source" }), NOW);
      using inspection = new DatabaseSync(path, { readOnly: true });
      const before = inspection.prepare("SELECT * FROM social_source_state").all();
      expect(database.applySocialImport(first, NOW)).toEqual(acknowledgment);
      expect(inspection.prepare("SELECT * FROM social_source_state").all()).toEqual(before);
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM social_import_operations").get()).toEqual({ count: 4 });
      expect(database.listSources()[0]!.socialPublication?.status).toBe("revoked");
    });
  });

  it("creates material A→B→A revision 3, deduplicates identical latest metadata and rejects ID/sequence collisions", () => {
    withDatabase((database, path) => {
      const value = fixture();
      const first = input(value, 1);
      database.applySocialImport(first, NOW);
      database.applySocialImport(input(value, 2, [{ tid: "post-1", title: "Metadata B" }]), NOW);
      database.applySocialImport(input(value, 3), NOW);
      expect(database.listRecentSourceEntries()[0]!.social?.revisionNumber).toBe(3);
      database.applySocialImport(input(value, 4), NOW);
      expect(database.listRecentSourceEntries()[0]!.social?.revisionNumber).toBe(3);
      using inspection = new DatabaseSync(path, { readOnly: true });
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM social_item_revisions").get()).toEqual({ count: 3 });
      const original = first.authorization as { operation: SocialImportOperation };
      expect(() => database.applySocialImport(input(value, 5, [], { action: "revoke-source", operationId: original.operation.operationId }), NOW)).toThrow("ID collision");
      expect(() => database.applySocialImport(input(value, 4), NOW)).toThrow("sequence");
      expect(database.listRecentSourceEntries()[0]!.title).toBe("Metadata A");
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM social_import_operations").get()).toEqual({ count: 4 });
    });
  });

  it("retains cold tombstones, requires explicit full-bundle restore and keeps source revocation terminal", () => {
    withDatabase((database, path) => {
      const value = fixture();
      const coldId = itemId(value, "cold");
      database.applySocialImport(input(value, 1, [], { action: "suppress", sourceItemIds: [coldId] }), NOW);
      expect(database.listKnownSourceItemIds(value.source.policy.sourceId)).toEqual([]);
      expect(() => database.applySocialImport(input(value, 2, [{ tid: "cold", title: "Cold publication" }]), NOW)).toThrow("explicit restore");
      expect(() => database.applySocialImport(input(value, 2, [{ tid: "unseen", title: "Unseen restore" }], { action: "restore" }), NOW)).toThrow("existing suppression");
      database.applySocialImport(input(value, 2, [{ tid: "cold", title: "Restored cold metadata" }], { action: "restore" }), NOW);
      expect(database.listRecentSourceEntries()[0]!.title).toBe("Restored cold metadata");
      database.applySocialImport(input(value, 3, [], { action: "suppress", sourceItemIds: [coldId] }), NOW);
      database.applySocialImport(input(value, 4, [], { action: "revoke-source" }), NOW);
      expect(() => database.applySocialImport(input(value, 5, [{ tid: "cold", title: "Attempted restore" }], { action: "restore" }), NOW)).toThrow("terminal");
      expect(() => database.applySocialImport(input(value, 5), NOW)).toThrow("terminal");
      using reader = new InfoHubDatabaseReader(path);
      expect(reader.listRecentSourceEntries()).toEqual([]);
      expect(reader.listSources()[0]!.socialPublication).toEqual({ status: "revoked", changedAt: NOW.toISOString() });
    });
  });

  it("restores only named bundle identities and rolls back a mixed invalid restore", () => {
    withDatabase((database, path) => {
      const value = fixture();
      database.applySocialImport(input(value, 1, [], { action: "suppress", sourceItemIds: [itemId(value, "one"), itemId(value, "two")] }), NOW);
      expect(() => database.applySocialImport(input(value, 2, [
        { tid: "one", title: "Valid restoration" }, { tid: "three", title: "Not suppressed" },
      ], { action: "restore" }), NOW)).toThrow("existing suppression");
      database.applySocialImport(input(value, 2, [{ tid: "one", title: "Restored one" }], { action: "restore" }), NOW);
      expect(database.listRecentSourceEntries().map((entry) => entry.title)).toEqual(["Restored one"]);
      expect(() => database.applySocialImport(input(value, 3, [{ tid: "two", title: "Still suppressed" }]), NOW)).toThrow("explicit restore");
      using inspection = new DatabaseSync(path, { readOnly: true });
      expect(inspection.prepare("SELECT source_item_id FROM social_item_suppressions").all()).toEqual([{ source_item_id: itemId(value, "two") }]);
    });
  });

  it("applies global source/organization filters, order and limits to website/social union without fabricating notices", () => {
    withDatabase((database, path) => {
      const value = fixture();
      ingestWebsite(database);
      database.applySocialImport(input(value, 1, [
        { tid: "dated", title: "Newest social metadata" },
        { tid: "unknown", title: "Unknown publication time", publicationTime: { original: null, precision: "unknown", timezone: null, normalizedAt: null, publishedOn: null } },
      ]), NOW);
      const all = database.listRecentSourceEntries();
      expect(all.map((entry) => entry.title)).toEqual(["Newest social metadata", "Existing website notice", "Unknown publication time"]);
      expect(database.listRecentSourceEntries({ limit: 2 })).toEqual(all.slice(0, 2));
      expect(database.listRecentSourceEntries({ sourceId: SOURCE.id }).map((entry) => entry.title)).toEqual(["Existing website notice"]);
      expect(database.listRecentSourceEntries({ organizationId: SOURCE.organization.id })).toEqual(all);
      expect(database.listRecentSourceEntries({ organizationId: "absent-organization" })).toEqual([]);
      expect(database.listRecentNotices()).toHaveLength(1);
      expect(all[2]!.publishedAtRaw).toBeNull();
      expect(all[2]!.publishedOn).toBeNull();
      expect(all[2]!.social?.publicationTime.normalizedAt).toBeNull();
      using reader = new InfoHubDatabaseReader(path);
      expect(reader.listRecentSourceEntries({ limit: 2 })).toEqual(all.slice(0, 2));
      expect(reader.listRecentNotices()).toEqual(database.listRecentNotices());
    });
  });

  it("uses qualification expiry, not admission expiry or a control deadline, and keeps expired source metadata known", () => {
    withDatabase((database, path) => {
      const value = fixture();
      value.source.qualification.reviewUntil = "2026-10-09T11:00:00.000Z";
      database.applySocialImport(input(value, 1, [
        { tid: "one", title: "Will suppress" }, { tid: "two", title: "Still authorized" },
      ], { expiresAt: "2026-10-09T10:01:00.000Z" }), NOW);
      database.applySocialImport(input(value, 2, [], {
        action: "suppress", sourceItemIds: [itemId(value, "one")], expiresAt: "2026-10-09T10:00:01.000Z",
      }), NOW);
      vi.setSystemTime(new Date("2026-10-09T10:30:00.000Z"));
      expect(database.listRecentSourceEntries().map((entry) => entry.title)).toEqual(["Still authorized"]);
      using reader = new InfoHubDatabaseReader(path);
      expect(reader.listRecentSourceEntries()).toEqual(database.listRecentSourceEntries());
      vi.setSystemTime(new Date("2026-10-09T11:00:00.000Z"));
      expect(database.listRecentSourceEntries()).toEqual([]);
      expect(reader.listRecentSourceEntries()).toEqual([]);
      expect(reader.listSources()[0]!.socialPublication?.status).toBe("expired");
      expect(reader.listSources()[0]!.name).toBe(value.source.policy.displayName);
      using inspection = new DatabaseSync(path, { readOnly: true });
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM social_item_revisions").get()).toEqual({ count: 2 });
    });
  });

  it("hides old-policy items after current registration changes until independently reauthorized", () => {
    withDatabase((database, path) => {
      const value = fixture();
      const old = input(value, 1);
      database.applySocialImport(old, NOW);
      value.source.homepageUrl = "https://example.edu/new-social-home";
      database.applySocialImport(input(value, 2, [], { action: "suppress", sourceItemIds: [itemId(value, "cold")] }), NOW);
      expect(database.listRecentSourceEntries()).toEqual([]);
      using reader = new InfoHubDatabaseReader(path);
      expect(reader.listRecentSourceEntries()).toEqual([]);
      expect(reader.listSources()[0]!.url).toBe(value.source.homepageUrl);
      expect(() => database.applySocialImport(old, NOW)).toThrow("fingerprint mismatch");
      database.applySocialImport(input(value, 3), NOW);
      expect(reader.listRecentSourceEntries()[0]!.social?.revisionNumber).toBe(1);
      expect(reader.listRecentSourceEntries()[0]!.title).toBe("Metadata A");
    });
  });

  it("keeps sequence authority across key rotation and prevents native publisher/source namespace reassignment", () => {
    withDatabase((database) => {
      const value = fixture();
      database.applySocialImport(input(value, 3), NOW);
      const rotated = fixture();
      rotated.source = value.source;
      rotated.trust.sources = [rotated.source];
      expect(() => database.applySocialImport(input(rotated, 2), NOW)).toThrow("sequence");
      database.applySocialImport(input(rotated, 4), NOW);
      const replacement = fixture();
      replacement.source.policy.publisherIdentity.value = "987654";
      expect(() => database.applySocialImport(input(replacement, 5), NOW)).toThrow("publisher identity cannot change");
      const duplicatePublisher = fixture();
      duplicatePublisher.source.policy.sourceId = "duplicate-native-publisher";
      expect(() => database.applySocialImport(input(duplicatePublisher, 1), NOW)).toThrow("already belongs");
      expect(database.listSources()).toHaveLength(1);
    });
  });
});
