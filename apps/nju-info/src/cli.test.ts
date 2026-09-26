import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const cli = join(import.meta.dirname, "cli.ts");

it("validates the official instance through the root product command", () => {
  const result = spawnSync(
    "pnpm",
    ["nju-info", "--", "validate", "instances/official.json", "sources/nju"],
    { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
});

it("rejects mutable official GHCR image references before running a command", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "validate"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NJU_INFO_IMAGE_REF: "ghcr.io/zhongyangchuwu/nju-info-hub:latest",
    },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("official GHCR image must use an immutable");
});
