import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  jobPortalInformationSourceConfigSchema,
  jobPortalRecruitmentSourceConfigSchema,
} from "@nju-info/core";
import { loadSourceFile } from "./registry.js";

async function employmentSource(name: string) {
  return jobPortalInformationSourceConfigSchema.parse(
    await loadSourceFile(fileURLToPath(
      new URL(`../../../sources/nju/${name}`, import.meta.url),
    )),
  );
}

describe("employment source configs", () => {
  it.each([
    ["employment-news.yaml", "nju-employment-news", "NEWS"],
    ["employment-college.yaml", "nju-employment-college", "COLLEGE"],
    ["employment-guidance.yaml", "nju-employment-guidance", "GUIDE"],
  ] as const)("loads %s as an independent employment information source",
    async (file, id, contentType) => {
      const source = await employmentSource(file);
      expect(source).toMatchObject({
        id,
        organization: {
          id: "nju-career-center",
          name: "南京大学学生就业指导中心",
          kind: "service-unit",
        },
        adapter: {
          type: "job-portal-information",
          contentType,
          pageSize: 15,
        },
      });
      expect(new URL(source.url).hostname).toBe("job.nju.edu.cn");
      expect(new URL(source.url).searchParams.get("type")).toBe(contentType);
    },
  );

  it("loads employment-recruitments.yaml as a recruitment source", async () => {
    const source = jobPortalRecruitmentSourceConfigSchema.parse(
      await loadSourceFile(fileURLToPath(
        new URL(
          "../../../sources/nju/employment-recruitments.yaml",
          import.meta.url,
        ),
      )),
    );
    expect(source).toMatchObject({
      id: "nju-employment-recruitments",
      organization: {
        id: "nju-career-center",
        name: "南京大学学生就业指导中心",
        kind: "service-unit",
      },
      adapter: {
        type: "job-portal-recruitment",
        pageSize: 20,
      },
    });
    expect(source.url).toBe("https://job.nju.edu.cn/career/jobs-v2");
  });
});
