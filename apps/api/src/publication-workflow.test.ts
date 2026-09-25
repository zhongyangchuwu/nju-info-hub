import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(new URL("../../../.github/workflows/publish-cs-feeds.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const expectedPublishedSources = [
  ["nju-cs-graduate", 10],
  ["nju-cs-internal-notices", 10],
  ["nju-cs-seminars", 10],
  ["nju-itsc-notices", 10],
  ["nju-library-news-notices", 10],
  ["nju-graduate-school-notices", 10],
  ["nju-undergraduate-notices", 5],
  ["nju-youth-league-announcements", 5],
  ["nju-student-affairs-notices", 10],
] as const;

const csSetSources = [
  "nju-cs-graduate",
  "nju-cs-internal-notices",
  "nju-cs-seminars",
];

describe("public Pages workflow", () => {
  it("collects exactly the nine admitted sources with their reviewed full-notice targets", () => {
    const commands = [...workflow.matchAll(/pnpm worker -- ingest ([\w-]+) \"\$NJU_INFO_DB\" (\d+)/g)]
      .map((match) => [match[1], Number(match[2])] as const);
    expect(commands).toEqual(expectedPublishedSources);
    expect(commands.some(([source]) => source === "nju-student-exchange")).toBe(false);
  });

  it("exports all nine sources while keeping the curated cs set at three members", () => {
    const exportLine = workflow.split("\n").find((line) => line.includes("export-feeds --"));
    expect(exportLine).toBeDefined();
    for (const [source] of expectedPublishedSources) expect(exportLine).toContain(` ${source}`);
    expect(exportLine).not.toContain("nju-student-exchange");
    const setSources = [...exportLine!.matchAll(/--set-source ([\w-]+)/g)].map((match) => match[1]);
    expect(setSources).toEqual(csSetSources);
  });

  it("restores durable state before the best-effort Actions cache", () => {
    const configure = workflow.indexOf("name: Configure durable WebDAV state");
    const durableRestore = workflow.indexOf("name: Restore durable state snapshot");
    const cacheRestore = workflow.indexOf("name: Restore SQLite database cache");
    const collection = workflow.indexOf("name: Collect the nine published feeds");
    expect(configure).toBeGreaterThan(-1);
    expect(durableRestore).toBeGreaterThan(configure);
    expect(cacheRestore).toBeGreaterThan(durableRestore);
    expect(collection).toBeGreaterThan(cacheRestore);
    expect(workflow).toContain("if: steps.durable_restore.outputs.restored != 'true'");
    expect(workflow).toContain("falling back to Actions cache");
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
    expect(workflow).not.toMatch(/path:\s*\$\{\{\s*secrets\./);
  });
});
