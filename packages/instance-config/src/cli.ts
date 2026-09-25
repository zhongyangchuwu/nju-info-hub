import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadInstanceConfig } from "./config.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function run(args: string[]): void {
  const result = spawnSync("pnpm", args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const [command, configPathArg, sourceDirArg, ...rest] = argv;
  if (!command || !configPathArg || !sourceDirArg) {
    throw new Error("usage: instance <validate|collect|export> <config.json> <source-dir> [args...]");
  }

  const configPath = path.resolve(repoRoot, configPathArg);
  const sourceDir = path.resolve(repoRoot, sourceDirArg);
  const config = await loadInstanceConfig(configPath, sourceDir);

  if (command === "validate") return;

  if (command === "collect") {
    const [database] = rest;
    if (!database) throw new Error("collect requires <database>");
    for (const source of config.publication.sources) {
      run(["worker", "--", "ingest", source.id, database, String(source.limit)]);
    }
    return;
  }

  if (command === "export") {
    const [database, outputDir] = rest;
    if (!database || !outputDir) throw new Error("export requires <database> <output-dir>");
    const args = [
      "--filter", "@nju-info/api", "export-feeds", "--",
      database,
      outputDir,
      ...config.publication.sources.map((source) => source.id),
      "--base-url", config.deployment.publicBaseUrl,
    ];
    for (const set of config.publication.sets) {
      args.push("--opml", set.opml, "--set-id", set.id, "--set-title", set.title);
      for (const sourceId of set.sources) args.push("--set-source", sourceId);
    }
    run(args);
    return;
  }

  throw new Error(`unknown instance command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
