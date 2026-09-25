import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(new URL("../../../.github/workflows/publish-cs-feeds.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");
const officialConfigPath = fileURLToPath(new URL("../../../instances/official.json", import.meta.url));
const officialConfig = JSON.parse(readFileSync(officialConfigPath, "utf8"));

describe("public Pages workflow", () => {
  it("uses the checked-in official instance config for validation, collection, and export", () => {
    expect(workflow).toContain("pnpm nju-info -- validate instances/official.json sources/nju");
    expect(workflow).toContain('pnpm nju-info -- collect instances/official.json sources/nju "$NJU_INFO_DB"');
    expect(workflow).toContain(
      'pnpm nju-info -- export instances/official.json sources/nju "$NJU_INFO_DB" "$NJU_INFO_PAGES_DIR"',
    );
    expect(workflow).not.toContain("pnpm worker -- ingest nju-");
    expect(workflow).not.toContain("export-feeds --");
    expect(workflow).not.toContain("storage.mode");
    expect(workflow).not.toContain("instance_config.outputs.storage_mode");
  });

  it("keeps the GitHub schedule synchronized with official instance metadata", () => {
    const cron = workflow.match(/- cron: '([^']+)'/)?.[1];
    expect(cron).toBe(officialConfig.collection.schedule);
  });

  it("restores durable state before the best-effort Actions cache", () => {
    const configure = workflow.indexOf("name: Configure durable WebDAV state");
    const durableRestore = workflow.indexOf("name: Restore durable state snapshot");
    const cacheRestore = workflow.indexOf("name: Restore SQLite database cache");
    const collection = workflow.indexOf("name: Collect configured published feeds");
    expect(configure).toBeGreaterThan(-1);
    expect(durableRestore).toBeGreaterThan(configure);
    expect(cacheRestore).toBeGreaterThan(durableRestore);
    expect(collection).toBeGreaterThan(cacheRestore);
    expect(workflow).toContain("if: steps.durable_restore.outputs.restored != 'true'");
    expect(workflow).toContain("falling back to Actions cache");
    expect(workflow).not.toContain('rm -f "$snapshot" "$NJU_INFO_DB"');
  });

  it("fails durable persistence before Pages artifact upload when configured", () => {
    const cacheSave = workflow.indexOf("name: Save SQLite database cache");
    const durableSave = workflow.indexOf("name: Persist durable state snapshot");
    const artifactUpload = workflow.indexOf("uses: actions/upload-pages-artifact@v4");
    expect(cacheSave).toBeGreaterThan(-1);
    expect(durableSave).toBeGreaterThan(cacheSave);
    expect(artifactUpload).toBeGreaterThan(durableSave);
    expect(workflow).toContain("pnpm state:snapshot -- pack");
    expect(workflow).toContain("bash scripts/state-rclone.sh upload");
  });

  it("requires a complete WebDAV secret triplet and keeps secrets out of cache paths", () => {
    expect(workflow).toContain("durable WebDAV state requires URL, user, and password together");
    expect(workflow).toContain("NJU_INFO_STATE_WEBDAV_URL");
    expect(workflow).toContain("NJU_INFO_STATE_WEBDAV_USER");
    expect(workflow).toContain("NJU_INFO_STATE_WEBDAV_PASSWORD");
    expect(workflow).toContain("install -m 600 /dev/null");
    expect(workflow).toContain("rclone obscure -");
    expect(workflow).toContain('[[ "$remote_path" = /* || "$remote_path" == *:* || ! "$remote_path" =~ ^[A-Za-z0-9._/-]+$ ]]');
    expect(workflow).not.toMatch(/path:\s*\$\{\{\s*secrets\./);
  });
});
