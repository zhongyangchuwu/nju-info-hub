#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const releaseRoot = path.join(root, "dist/release");
const packagePaths = [
  "apps/api/package.json",
  "apps/nju-info/package.json",
  "apps/worker/package.json",
  "packages/collector/package.json",
  "packages/core/package.json",
  "packages/db/package.json",
  "packages/feed/package.json",
  "packages/instance-config/package.json",
];

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

const rootPackage = await readJson(path.join(root, "package.json"));
const manifests = new Map();
for (const relative of packagePaths) {
  const manifest = await readJson(path.join(root, relative));
  manifests.set(manifest.name, { manifest, relative });
}

const entry = manifests.get("@nju-info/nju-info")?.manifest;
if (!entry) throw new Error("missing @nju-info/nju-info package manifest");

const runtimeDependencies = new Map();
const visited = new Set();

function collect(name) {
  if (visited.has(name)) return;
  visited.add(name);
  const current = manifests.get(name);
  if (!current) throw new Error(`unknown internal package: ${name}`);

  for (const [dependency, version] of Object.entries(current.manifest.dependencies ?? {})) {
    if (version.startsWith("workspace:")) {
      collect(dependency);
      continue;
    }
    const previous = runtimeDependencies.get(dependency);
    if (previous && previous !== version) {
      throw new Error(`conflicting runtime dependency versions for ${dependency}: ${previous} vs ${version}`);
    }
    runtimeDependencies.set(dependency, version);
  }
}
collect(entry.name);

await fs.rm(releaseRoot, { recursive: true, force: true });
await fs.mkdir(path.join(releaseRoot, "dist"), { recursive: true });

const external = [...runtimeDependencies.keys()].flatMap((dependency) => [
  dependency,
  `${dependency}/*`,
]);

await build({
  entryPoints: [path.join(root, "apps/nju-info/src/cli.ts")],
  outfile: path.join(releaseRoot, "dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  external,
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

await fs.chmod(path.join(releaseRoot, "dist/cli.js"), 0o755);

const resources = path.join(releaseRoot, "resources");
await fs.mkdir(path.join(resources, "scripts"), { recursive: true });
await fs.cp(path.join(root, "sources/nju"), path.join(resources, "sources/nju"), { recursive: true });
await fs.cp(path.join(root, "instances"), path.join(resources, "instances"), { recursive: true });
await fs.copyFile(
  path.join(root, "scripts/state-snapshot.mjs"),
  path.join(resources, "scripts/state-snapshot.mjs"),
);

const version = process.env.NJU_INFO_VERSION || entry.version;
const artifactPackage = {
  name: entry.name,
  version,
  private: true,
  description: "Public, read-only information aggregation for Nanjing University",
  type: "module",
  bin: { "nju-info": "dist/cli.js" },
  engines: rootPackage.engines,
  dependencies: Object.fromEntries([...runtimeDependencies.entries()].sort(([a], [b]) => a.localeCompare(b))),
  files: ["dist", "resources", "README.md"],
};

await fs.writeFile(
  path.join(releaseRoot, "package.json"),
  JSON.stringify(artifactPackage, null, 2) + "\n",
);
await fs.copyFile(path.join(root, "README.md"), path.join(releaseRoot, "README.md"));

console.log(`release artifact: ${releaseRoot}`);
console.log(`runtime dependencies: ${runtimeDependencies.size}`);
