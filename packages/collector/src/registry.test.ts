import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSourceDirectory } from "./registry.js";

describe("source registry", () => {
  it("loads checked-in NJU sources with unique ids", async () => {
    const directory = fileURLToPath(
      new URL("../../../sources/nju/", import.meta.url),
    );
    const sources = await loadSourceDirectory(directory);
    const ids = sources.map((source) => source.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
