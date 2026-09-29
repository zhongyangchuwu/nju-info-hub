import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadInstanceConfig } from "./config.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceDir = path.join(repoRoot, "sources/nju");
const officialPath = path.join(repoRoot, "instances/official.json");

async function official(): Promise<any> {
  return JSON.parse(await readFile(officialPath, "utf8"));
}

async function writeConfig(value: any): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nju-instance-"));
  const file = path.join(dir, "instance.json");
  await writeFile(file, JSON.stringify(value));
  return file;
}

async function withConfig(mutator: (value: any) => void): Promise<string> {
  const value = await official();
  mutator(value);
  return writeConfig(value);
}

describe("instance config", () => {
  it("loads the official v4 collection and publication policy", async () => {
    const config = await loadInstanceConfig(officialPath, sourceDir);
    expect(config.schemaVersion).toBe(4);
    expect(config.publication.sources).toHaveLength(30);
    expect(config.publication.publicBaseUrl)
      .toBe("https://zhongyangchuwu.github.io/nju-info-hub/");
    expect(config.publication.sources.slice(-5)).toEqual([
      "nju-business-school-notices",
      "nju-chemistry-student-notices",
      "nju-environment-notices",
      "nju-earth-sciences-notices",
      "nju-modern-engineering-notices",
    ]);
    expect(config.publication.sets).toEqual([{
      id: "cs",
      title: "计算机学院公开信息",
      sources: [
        "nju-cs-graduate",
        "nju-cs-internal-notices",
        "nju-cs-seminars",
      ],
      opml: "subscriptions/cs.opml",
    }]);
    expect(config.collection.schedule).toBe("17 */2 * * *");
    expect(config.collection.timeZone).toBe("UTC");
    expect(config.collection.sources).toHaveLength(30);
    expect(config.collection.sources[0]).toEqual({
      id: "nju-cs-graduate",
      recentLimit: 10,
    });
    expect(config.collection.sources.slice(-5)).toEqual([
      { id: "nju-business-school-notices", recentLimit: 5 },
      { id: "nju-chemistry-student-notices", recentLimit: 5 },
      { id: "nju-environment-notices", recentLimit: 5 },
      { id: "nju-earth-sciences-notices", recentLimit: 5 },
      { id: "nju-modern-engineering-notices", recentLimit: 5 },
    ]);
  });

  it("rejects the obsolete v3 instance shape", async () => {
    const current = await official();
    const file = await writeConfig({
      ...current,
      schemaVersion: 3,
      publication: {
        ...current.publication,
        itemLimit: 100,
      },
    });
    await expect(loadInstanceConfig(file, sourceDir)).rejects.toThrow();
  });

  it("rejects invalid cron schedules and time zones", async () => {
    const badSchedule = await withConfig((value) => {
      value.collection.schedule = "not a cron";
    });
    await expect(loadInstanceConfig(badSchedule, sourceDir))
      .rejects.toThrow("invalid cron schedule");

    const badZone = await withConfig((value) => {
      value.collection.timeZone = "Moon/SeaOfTranquility";
    });
    await expect(loadInstanceConfig(badZone, sourceDir))
      .rejects.toThrow("invalid IANA time zone");
  });

  it("rejects unknown and duplicate collection sources", async () => {
    const unknown = await withConfig((value) => {
      value.collection.sources.push({ id: "missing-source", recentLimit: 1 });
    });
    await expect(loadInstanceConfig(unknown, sourceDir))
      .rejects.toThrow("unknown collection source id: missing-source");

    const duplicate = await withConfig((value) => {
      value.collection.sources.push(value.collection.sources[0]);
    });
    await expect(loadInstanceConfig(duplicate, sourceDir))
      .rejects.toThrow("duplicate collection source id");
  });

  it("rejects unknown, duplicate, and uncollected published sources", async () => {
    const unknown = await withConfig((value) => {
      value.publication.sources.push("missing-source");
    });
    await expect(loadInstanceConfig(unknown, sourceDir))
      .rejects.toThrow("unknown published source id: missing-source");

    const duplicate = await withConfig((value) => {
      value.publication.sources.push(value.publication.sources[0]);
    });
    await expect(loadInstanceConfig(duplicate, sourceDir))
      .rejects.toThrow("duplicate published source id");

    let uncollectedId = "";
    const uncollected = await withConfig((value) => {
      uncollectedId = value.publication.sources.at(-1);
      value.collection.sources = value.collection.sources.filter(
        ({ id }: { id: string }) => id !== uncollectedId,
      );
    });
    await expect(loadInstanceConfig(uncollected, sourceDir))
      .rejects.toThrow(
        `published source id is not collected by this instance: ${uncollectedId}`,
      );
  });

  it("rejects multiple, duplicate, and unpublished curated-set members", async () => {
    const multiple = await withConfig((value) => value.publication.sets.push({
      id: "second",
      title: "Second",
      sources: ["nju-cs-graduate"],
      opml: "subscriptions/second.opml",
    }));
    await expect(loadInstanceConfig(multiple, sourceDir))
      .rejects.toThrow("at most one curated source set");

    const duplicate = await withConfig((value) =>
      value.publication.sets[0].sources.push("nju-cs-graduate"));
    await expect(loadInstanceConfig(duplicate, sourceDir))
      .rejects.toThrow("duplicate source id in set cs");

    let unpublishedId = "";
    const unpublished = await withConfig((value) => {
      unpublishedId = value.publication.sources.find(
        (id: string) => !value.publication.sets[0].sources.includes(id),
      );
      value.publication.sources = value.publication.sources.filter(
        (id: string) => id !== unpublishedId,
      );
      value.publication.sets[0].sources.push(unpublishedId);
    });
    await expect(loadInstanceConfig(unpublished, sourceDir)).rejects.toThrow(
      `source set cs references unpublished source id: ${unpublishedId}`,
    );
  });
});
