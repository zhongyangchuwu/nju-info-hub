import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const cli = join(import.meta.dirname, "cli.ts");
const pinnedImage = "ghcr.io/zhongyangchuwu/nju-info-hub:sha-5f7754a";

it("refuses mutable image references before source enumeration without disclosing secret-shaped reference text", () => {
  const command = ["--import", "tsx", cli, "source", "sources"];
  const accepted = spawnSync(process.execPath, command, {
    cwd: repoRoot, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, NJU_INFO_IMAGE_REF: pinnedImage },
  });
  expect(accepted.status).toBe(0);
  expect(JSON.parse(accepted.stdout)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "nju-undergraduate-notices" }),
  ]));
  const rejected = spawnSync(process.execPath, command, {
    cwd: repoRoot, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, NJU_INFO_IMAGE_REF: "ghcr.io/zhongyangchuwu/nju-info-hub:latest?token=do-not-log-cli-value" },
  });
  expect(rejected.status).toBe(1);
  expect(rejected.stdout).toBe("");
  expect(JSON.parse(rejected.stderr).input.code).toBe("invalid_image_ref");
  expect(rejected.stderr).not.toContain("do-not-log-cli-value");
});

it("distinguishes command, required-path and limit errors with safe guidance before acquisition", () => {
  const cases = [
    { args: ["do-not-log-cli-value"], code: "unknown_command" },
    { args: ["source", "ingest", "nju-undergraduate-notices"], code: "usage_source_ingest" },
    { args: ["source", "fetch", "nju-undergraduate-notices", "do-not-log-cli-value"], code: "invalid_limit" },
  ];
  for (const entry of cases) {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...entry.args], {
      cwd: repoRoot, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, NJU_INFO_IMAGE_REF: pinnedImage },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const failure = JSON.parse(result.stderr);
    expect(failure.input.code).toBe(entry.code);
    expect(result.stderr).not.toContain("do-not-log-cli-value");
  }
});
