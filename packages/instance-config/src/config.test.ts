import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadInstanceConfig } from "./config.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceDir = path.join(repoRoot, "sources/nju");
const officialPath = path.join(repoRoot, "instances/official.json");

async function withConfig(mutator: (value: any) => void): Promise<string> {
  const value = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(officialPath, "utf8")));
  mutator(value);
  const dir = await mkdtemp(path.join(tmpdir(), "nju-instance-"));
  const file = path.join(dir, "instance.json");
  await writeFile(file, JSON.stringify(value));
  return file;
}

describe("instance config", () => {
  it("accepts the pnpm argument separator on the root CLI", () => {
    const result = spawnSync(
      "pnpm",
      ["instance", "--", "validate", "instances/official.json", "sources/nju"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("loads the official deployment with nine published sources and the three-source cs set", async () => {
    const config = await loadInstanceConfig(officialPath, sourceDir);
    expect(config.publication.sources).toHaveLength(9);
    expect(config.publication.sets).toEqual([
      {
        id: "cs",
        title: "计算机学院公开信息",
        sources: ["nju-cs-graduate", "nju-cs-internal-notices", "nju-cs-seminars"],
        opml: "subscriptions/cs.opml",
      },
    ]);
    expect(config.deployment.publicBaseUrl).toBe("https://zhongyangchuwu.github.io/nju-info-hub/");
    expect(config.storage.mode).toBe("optional-webdav");
  });

  it("rejects unknown published sources", async () => {
    const file = await withConfig((value) => value.publication.sources.push({ id: "missing-source", limit: 1 }));
    await expect(loadInstanceConfig(file, sourceDir)).rejects.toThrow("unknown published source id: missing-source");
  });

  it("rejects duplicate published sources", async () => {
    const file = await withConfig((value) => value.publication.sources.push(value.publication.sources[0]));
    await expect(loadInstanceConfig(file, sourceDir)).rejects.toThrow("duplicate published source id");
  });

  it("rejects multiple curated source sets in v1", async () => {
    const file = await withConfig((value) => value.publication.sets.push({
      id: "second",
      title: "Second",
      sources: ["nju-cs-graduate"],
      opml: "subscriptions/second.opml",
    }));
    await expect(loadInstanceConfig(file, sourceDir)).rejects.toThrow("v1 supports at most one curated source set");
  });

  it("rejects duplicate and unpublished curated-set members", async () => {
    const duplicate = await withConfig((value) => value.publication.sets[0].sources.push("nju-cs-graduate"));
    await expect(loadInstanceConfig(duplicate, sourceDir)).rejects.toThrow("duplicate source id in set cs");

    const unpublished = await withConfig((value) => value.publication.sets[0].sources.push("nju-student-exchange"));
    await expect(loadInstanceConfig(unpublished, sourceDir)).rejects.toThrow(
      "source set cs references unpublished source id: nju-student-exchange",
    );
  });
});
