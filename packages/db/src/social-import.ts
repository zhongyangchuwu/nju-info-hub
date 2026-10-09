import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { verifySocialImport } from "@nju-info/core";
import type {
  SocialEnvelopePayload,
  SocialImportInput,
  SocialImportResult,
} from "@nju-info/core";

interface OperationRow {
  source_id: string;
  sequence: number;
  operation_sha256: string;
  action: SocialImportResult["action"];
  imported_items: number;
  suppressed_items: number;
}

interface SourceStateRow {
  publisher_key: string;
  revoked: number;
  latest_sequence: number;
}

/** Verify untrusted transport before acquiring a write transaction or changing any state. */
export function applySocialImport(
  database: DatabaseSync,
  input: SocialImportInput,
  now: Date,
): SocialImportResult {
  const verified = verifySocialImport(input, now);
  const { operation, source } = verified;
  const appliedAt = now.toISOString();
  // Authorization expiry governs admission/replay; serving follows source qualification.
  const expiresAt = new Date(source.qualification.reviewUntil).toISOString();
  const publisherKey = JSON.stringify([source.policy.platform, source.policy.publisherIdentity]);

  database.exec("BEGIN IMMEDIATE");
  try {
    const previous = database.prepare(
      "SELECT source_id, sequence, operation_sha256, action, imported_items, suppressed_items FROM social_import_operations WHERE operation_id = ?",
    ).get(operation.operationId) as unknown as OperationRow | undefined;
    if (previous) {
      if (previous.operation_sha256 !== verified.operationSha256) {
        throw new Error("social operation ID collision");
      }
      // A replay is an acknowledgment, not a reapplication of historical state.
      database.exec("COMMIT");
      return {
        status: "replayed",
        sourceId: previous.source_id,
        sequence: previous.sequence,
        action: previous.action,
        importedItems: previous.imported_items,
        suppressedItems: previous.suppressed_items,
      };
    }

    const existingSource = database.prepare("SELECT adapter_type FROM sources WHERE id = ?")
      .get(operation.sourceId);
    if (existingSource && existingSource.adapter_type !== "social-acquisition") {
      throw new Error("social source ID collides with a website source");
    }
    const state = database.prepare(
      "SELECT publisher_key, revoked, latest_sequence FROM social_source_state WHERE source_id = ?",
    ).get(operation.sourceId) as unknown as SourceStateRow | undefined;
    if (state && state.publisher_key !== publisherKey) {
      throw new Error("social source native publisher identity cannot change");
    }
    if (state && operation.sequence <= state.latest_sequence) {
      throw new Error("social operation sequence must exceed the latest accepted sequence");
    }
    if (state?.revoked && (operation.action === "publish" || operation.action === "restore")) {
      throw new Error("social source revocation is terminal");
    }
    const otherPublisherSource = database.prepare(
      "SELECT source_id FROM social_source_state WHERE publisher_key = ? AND source_id <> ?",
    ).get(publisherKey, operation.sourceId);
    if (otherPublisherSource) throw new Error("social native publisher already belongs to another source");

    const items = verified.bundle?.envelopes ?? [];
    const findSuppression = database.prepare(
      "SELECT 1 FROM social_item_suppressions WHERE source_id = ? AND source_item_id = ?",
    );
    for (const envelope of items) {
      const suppressed = findSuppression.get(operation.sourceId, envelope.payload.item.sourceItemId);
      if (operation.action === "publish" && suppressed) {
        throw new Error("publishing a suppressed social item requires explicit restore");
      }
      if (operation.action === "restore" && !suppressed) {
        throw new Error("restoring a social item requires an existing suppression");
      }
    }

    database.prepare(`INSERT INTO sources (
      id, name, organization_id, organization_name, homepage_url, adapter_type,
      config_json, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'social-acquisition', ?, 1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name,
      organization_id = excluded.organization_id, organization_name = excluded.organization_name,
      homepage_url = excluded.homepage_url, config_json = excluded.config_json,
      updated_at = excluded.updated_at`).run(
      operation.sourceId, source.policy.displayName, source.organization.id,
      source.organization.name, source.homepageUrl, JSON.stringify(source.policy), appliedAt, appliedAt,
    );
    database.prepare(`INSERT INTO social_source_state (
      source_id, publisher_key, policy_sha256, registration_json, expires_at,
      revoked, changed_at, latest_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id) DO UPDATE SET policy_sha256 = excluded.policy_sha256,
      registration_json = excluded.registration_json, expires_at = excluded.expires_at,
      revoked = MAX(social_source_state.revoked, excluded.revoked),
      changed_at = excluded.changed_at, latest_sequence = excluded.latest_sequence`).run(
      operation.sourceId, publisherKey, operation.policySha256, JSON.stringify(source),
      expiresAt, operation.action === "revoke-source" ? 1 : 0, appliedAt, operation.sequence,
    );

    const result: SocialImportResult = {
      status: "applied", sourceId: operation.sourceId, sequence: operation.sequence,
      action: operation.action, importedItems: items.length,
      suppressedItems: operation.action === "suppress" ? operation.sourceItemIds.length : 0,
    };
    // Immutable signed transport and exact public-safe raw bytes precede normalization.
    database.prepare(`INSERT INTO social_import_operations (
      operation_id, source_id, sequence, operation_sha256, authorization_bytes, bundle_bytes,
      action, issued_at, expires_at, policy_sha256, applied_at, imported_items, suppressed_items
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      operation.operationId, operation.sourceId, operation.sequence, verified.operationSha256,
      verified.authorizationBytes, verified.bundleBytes, operation.action,
      operation.issuedAt, operation.expiresAt, operation.policySha256, appliedAt,
      result.importedItems, result.suppressedItems,
    );
    const insertBlob = database.prepare(
      "INSERT INTO social_raw_blobs (sha256, body) VALUES (?, ?) ON CONFLICT (sha256) DO NOTHING",
    );
    const linkBlob = database.prepare(
      "INSERT INTO social_operation_blobs (operation_id, sha256) VALUES (?, ?)",
    );
    for (const [sha256, bytes] of verified.blobs) {
      insertBlob.run(sha256, bytes);
      linkBlob.run(operation.operationId, sha256);
    }

    for (const envelope of items) {
      const payload = envelope.payload;
      const sourceItemId = payload.item.sourceItemId;
      database.prepare(`INSERT INTO source_items (source_id, source_item_id, url, first_seen_at)
        VALUES (?, ?, ?, ?) ON CONFLICT (source_id, source_item_id) DO UPDATE SET url = excluded.url`)
        .run(operation.sourceId, sourceItemId, payload.item.canonicalUrl, appliedAt);
      const itemRow = database.prepare("SELECT id FROM source_items WHERE source_id = ? AND source_item_id = ?")
        .get(operation.sourceId, sourceItemId);
      const itemRowId = Number(itemRow!.id);
      const latest = database.prepare(`SELECT id, revision_number, material_sha256
        FROM social_item_revisions WHERE source_item_row_id = ? ORDER BY revision_number DESC LIMIT 1`)
        .get(itemRowId) as { id: number; revision_number: number; material_sha256: string } | undefined;
      const materialSha256 = socialMaterialSha256(payload);
      let revisionId = latest?.id;
      if (!latest || latest.material_sha256 !== materialSha256) {
        const inserted = database.prepare(`INSERT INTO social_item_revisions (
          source_item_row_id, revision_number, material_sha256, payload_json,
          raw_sha256, operation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          itemRowId, (latest?.revision_number ?? 0) + 1, materialSha256, JSON.stringify(payload),
          payload.rawBlobs[0]!.blob.sha256, operation.operationId, appliedAt,
        );
        revisionId = Number(inserted.lastInsertRowid);
      }
      database.prepare(`INSERT INTO social_item_publications (
        source_item_row_id, revision_id, operation_id, policy_sha256, expires_at, acquired_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_item_row_id) DO UPDATE SET revision_id = excluded.revision_id,
        operation_id = excluded.operation_id, policy_sha256 = excluded.policy_sha256,
        expires_at = excluded.expires_at, acquired_at = excluded.acquired_at,
        applied_at = excluded.applied_at`).run(
        itemRowId, revisionId!, operation.operationId, operation.policySha256, expiresAt,
        envelope.provenance.acquiredAt, appliedAt,
      );
      if (operation.action === "restore") {
        database.prepare("DELETE FROM social_item_suppressions WHERE source_id = ? AND source_item_id = ?")
          .run(operation.sourceId, sourceItemId);
      }
    }
    if (operation.action === "suppress") {
      const suppress = database.prepare(`INSERT INTO social_item_suppressions (
        source_id, source_item_id, operation_id, changed_at
      ) VALUES (?, ?, ?, ?) ON CONFLICT (source_id, source_item_id) DO UPDATE SET
        operation_id = excluded.operation_id, changed_at = excluded.changed_at`);
      for (const sourceItemId of operation.sourceItemIds) {
        suppress.run(operation.sourceId, sourceItemId, operation.operationId, appliedAt);
      }
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function socialMaterialSha256(payload: SocialEnvelopePayload): string {
  // Acquisition/provider/run clocks and raw descriptors are evidence, not content revisions.
  return createHash("sha256").update(JSON.stringify({
    source: payload.source,
    item: payload.item,
    publicationTime: payload.publicationTime,
    content: payload.content,
    attribution: payload.attribution,
  })).digest("hex");
}
