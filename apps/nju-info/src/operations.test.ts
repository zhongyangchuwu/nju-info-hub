import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSourceDirectory, ingestSource } = vi.hoisted(() => ({
  loadSourceDirectory: vi.fn(),
  ingestSource: vi.fn(),
}));

vi.mock("@nju-info/collector", () => ({ loadSourceDirectory }));
vi.mock("@nju-info/worker/collection", () => ({ ingestSource }));

import type { InstanceConfig } from "@nju-info/instance-config";
import { collectInstance } from "./operations.js";

const source = (id: string) => ({
  schemaVersion: 1 as const,
  id,
  name: id,
  organization: { id: "nju-test", name: "Test" },
  url: `https://example.edu/${id}/list.htm`,
  adapter: { type: "webplus" as const },
});

const config: InstanceConfig = {
  schemaVersion: 4,
  instance: { id: "test", name: "Test" },
  publication: {
    publicBaseUrl: "https://example.invalid/",
    sources: ["source-a", "source-b", "source-c"],
    sets: [],
  },
  collection: {
    schedule: "0 * * * *",
    timeZone: "UTC",
    sources: [
      { id: "source-a", recentLimit: 10 },
      { id: "source-b", recentLimit: 10 },
      { id: "source-c", recentLimit: 10 },
    ],
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
  loadSourceDirectory.mockResolvedValue([
    source("source-a"),
    source("source-b"),
    source("source-c"),
  ]);
});

describe("collectInstance", () => {
  it("keeps collecting later sources after one source fails", async () => {
    ingestSource
      .mockResolvedValueOnce({ sourceId: "source-a" })
      .mockRejectedValueOnce(new Error("temporary source-b failure"))
      .mockResolvedValueOnce({ sourceId: "source-c" });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await collectInstance(config, "/tmp/test.sqlite", "/tmp/sources");

    expect(ingestSource).toHaveBeenCalledTimes(3);
    expect(ingestSource).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ id: "source-c" }),
      "/tmp/test.sqlite",
      10,
    );
    expect(result).toEqual({
      succeededSources: ["source-a", "source-c"],
      failedSources: [{
        sourceId: "source-b",
        message: "temporary source-b failure",
      }],
    });
    expect(stderr).toHaveBeenCalledWith(
      "[collection] source source-b failed: temporary source-b failure",
    );
  });

  it("fails the collection run when every configured source fails", async () => {
    ingestSource.mockRejectedValue(new Error("network unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(collectInstance(config, "/tmp/test.sqlite", "/tmp/sources"))
      .rejects.toThrow("all 3 configured sources failed collection");
    expect(ingestSource).toHaveBeenCalledTimes(3);
  });
});
