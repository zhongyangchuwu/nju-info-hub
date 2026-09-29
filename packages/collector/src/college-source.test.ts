import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSourceFile } from "./registry.js";

const CASES = [
  {
    file: "ai-notices.yaml",
    id: "nju-ai-notices",
    organizationId: "nju-ai-school",
    adapter: { type: "webplus" },
  },
  {
    file: "software-notices.yaml",
    id: "nju-software-notices",
    organizationId: "nju-software-school",
    adapter: {
      type: "boshan",
      channelId: 6439,
      pageSize: 15,
      selectors: { content: ".content" },
    },
  },
  {
    file: "math-announcements.yaml",
    id: "nju-math-announcements",
    organizationId: "nju-math-school",
    adapter: {
      type: "boshan",
      channelId: 16411,
      pageSize: 15,
      selectors: { content: ".article_content" },
    },
  },
  {
    file: "physics-notices.yaml",
    id: "nju-physics-notices",
    organizationId: "nju-physics-school",
    adapter: {
      type: "boshan",
      channelId: 16198,
      pageSize: 15,
      selectors: { content: ".mn-contentInfo" },
    },
  },
  {
    file: "business-school-notices.yaml",
    id: "nju-business-school-notices",
    organizationId: "nju-business-school",
    adapter: { type: "webplus" },
  },
  {
    file: "chemistry-student-notices.yaml",
    id: "nju-chemistry-student-notices",
    organizationId: "nju-chemistry-school",
    adapter: {
      type: "boshan",
      channelId: 16854,
      pageSize: 15,
      selectors: { content: ".view-cnt" },
    },
  },
  {
    file: "environment-notices.yaml",
    id: "nju-environment-notices",
    organizationId: "nju-environment-school",
    adapter: {
      type: "boshan",
      channelId: 12778,
      pageSize: 15,
      selectors: { content: "#content" },
    },
  },
  {
    file: "earth-sciences-notices.yaml",
    id: "nju-earth-sciences-notices",
    organizationId: "nju-earth-sciences-school",
    adapter: { type: "webplus" },
  },
  {
    file: "modern-engineering-notices.yaml",
    id: "nju-modern-engineering-notices",
    organizationId: "nju-modern-engineering-school",
    adapter: { type: "webplus" },
  },
] as const;
describe("representative college source configs", () => {
  it.each(CASES)("loads $file with the expected generic adapter", async ({
    file,
    id,
    organizationId,
    adapter,
  }) => {
    const source = await loadSourceFile(fileURLToPath(
      new URL(`../../../sources/nju/${file}`, import.meta.url),
    ));
    expect(source).toMatchObject({
      id,
      organization: {
        id: organizationId,
        kind: "academic-unit",
      },
      adapter,
    });
  });
});
