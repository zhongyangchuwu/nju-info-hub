#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const releaseRoot = path.join(root, "dist/release");
const releasePackagePath = path.join(releaseRoot, "package.json");

if (!existsSync(releasePackagePath)) {
  throw new Error("release artifact is missing; run pnpm build first");
}

const releasePackage = JSON.parse(readFileSync(releasePackagePath, "utf8"));
for (const dependency of Object.keys(releasePackage.dependencies ?? {})) {
  if (dependency.startsWith("@nju-info/")) {
    throw new Error(`release artifact must not depend on internal workspace package: ${dependency}`);
  }
}
if (releasePackage.dependencies?.tsx || releasePackage.dependencies?.typescript) {
  throw new Error("release artifact must not depend on tsx or TypeScript");
}

const directory = mkdtempSync(path.join(tmpdir(), "nju-info-release-smoke-"));
const installRoot = path.join(directory, "install");

try {
  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", releaseRoot, "--pack-destination", directory, "--json"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ));
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not report a tarball filename");
  const tarball = path.join(directory, filename);

  execFileSync(
    "npm",
    ["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );

  const installedRoot = path.join(installRoot, "node_modules", "@nju-info", "nju-info");
  if (existsSync(path.join(installedRoot, "src"))) {
    throw new Error("installed release package unexpectedly contains TypeScript source");
  }

  const bin = path.join(installRoot, "node_modules", ".bin", "nju-info");
  const sources = JSON.parse(execFileSync(bin, ["source", "sources"], { encoding: "utf8" }));
  const expectedSources = readdirSync(path.join(releaseRoot, "resources/sources/nju"))
    .filter((name) => name.endsWith(".yaml")).length;
  if (sources.length !== expectedSources) {
    throw new Error(`release source count mismatch: expected ${expectedSources}, got ${sources.length}`);
  }

  execFileSync(bin, ["validate"], { stdio: "pipe" });
  console.log(`release smoke passed: ${filename} (${sources.length} sources)`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
