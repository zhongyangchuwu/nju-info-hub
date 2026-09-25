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
  it("loads the official config without changing publication behavior", async () => {
    const config = await loadInstanceConfig(officialPath, sourceDir);
    expect(config.schemaVersion).toBe(2);
    expect(config.publication.sources).toHaveLength(9);
    expect(config.publication.publicBaseUrl).toBe("https://zhongyangchuwu.github.io/nju-info-hub/");
    expect(config.publication.sets[0]?.sources).toEqual([
      "nju-cs-graduate",
      "nju-cs-internal-notices",
      "nju-cs-seminars",
    ]);
    expect(config.collection).toEqual({ schedule: "17 */2 * * *", timeZone: "UTC" });
  });

  it("rejects the obsolete v1 instance shape", async () => {
    const current = await official();
    const file = await writeConfig({
      schemaVersion: 1,
      instance: current.instance,
      publication: {
        sources: current.publication.sources,
        sets: current.publication.sets,
      },
      deployment: {
        publicBaseUrl: current.publication.publicBaseUrl,
        schedule: current.collection.schedule,
      },
    });
    await expect(loadInstanceConfig(file, sourceDir)).rejects.toThrow();
  });

  it("rejects invalid cron schedules and time zones", async () => {
    const badSchedule = await withConfig((value) => { value.collection.schedule = "not a cron"; });
    await expect(loadInstanceConfig(badSchedule, sourceDir)).rejects.toThrow("invalid cron schedule");

    const badZone = await withConfig((value) => { value.collection.timeZone = "Moon/SeaOfTranquility"; });
    await expect(loadInstanceConfig(badZone, sourceDir)).rejects.toThrow("invalid IANA time zone");
  });

  it("rejects unknown or duplicate published sources", async () => {
    const unknown = await withConfig((value) => value.publication.sources.push({ id: "missing-source", limit: 1 }));
    await expect(loadInstanceConfig(unknown, sourceDir)).rejects.toThrow("unknown published source id: missing-source");

    const duplicate = await withConfig((value) => value.publication.sources.push(value.publication.sources[0]));
    await expect(loadInstanceConfig(duplicate, sourceDir)).rejects.toThrow("duplicate published source id");
  });

  it("rejects multiple, duplicate, and unpublished curated-set members", async () => {
    const multiple = await withConfig((value) => value.publication.sets.push({
      id: "second",
      title: "Second",
      sources: ["nju-cs-graduate"],
      opml: "subscriptions/second.opml",
    }));
    await expect(loadInstanceConfig(multiple, sourceDir)).rejects.toThrow("at most one curated source set");

    const duplicate = await withConfig((value) => value.publication.sets[0].sources.push("nju-cs-graduate"));
    await expect(loadInstanceConfig(duplicate, sourceDir)).rejects.toThrow("duplicate source id in set cs");

    const unpublished = await withConfig((value) => value.publication.sets[0].sources.push("nju-student-exchange"));
    await expect(loadInstanceConfig(unpublished, sourceDir)).rejects.toThrow(
      "source set cs references unpublished source id: nju-student-exchange",
    );
  });
});
