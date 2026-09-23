import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSourceDirectory } from "./registry.js";

const EXPECTED_SOURCE_IDS = [
  "nju-academic-calendar",
  "nju-cs-graduate",
  "nju-cs-internal-notices",
  "nju-cs-seminars",
  "nju-graduate-school-notices",
  "nju-itsc-notices",
  "nju-science-tech",
  "nju-student-affairs-notices",
  "nju-student-exchange",
].sort();

describe("source registry", () => {
  it("loads the checked-in NJU inventory with unique ids", async () => {
    const directory = fileURLToPath(
      new URL("../../../sources/nju/", import.meta.url),
    );
    const sources = await loadSourceDirectory(directory);
    const ids = sources.map((source) => source.id).sort();

    expect(ids).toEqual(EXPECTED_SOURCE_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
