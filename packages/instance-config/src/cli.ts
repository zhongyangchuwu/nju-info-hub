import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { loadInstanceConfig } from "./config.js";
import { collectInstance, createPnpmRunner, exportInstance } from "./operations.js";
import { createCollectionScheduler } from "./scheduler.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const run = createPnpmRunner(repoRoot);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForShutdown(stop: () => void): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      stop();
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const [command, configPathArg, sourceDirArg, ...rest] = argv;
  if (!command || !configPathArg || !sourceDirArg) {
    throw new Error("usage: instance <validate|collect|export|schedule> <config.json> <source-dir> [args...]");
  }

  const configPath = path.resolve(repoRoot, configPathArg);
  const sourceDir = path.resolve(repoRoot, sourceDirArg);
  const config = await loadInstanceConfig(configPath, sourceDir);

  if (command === "validate") return;

  if (command === "collect") {
    const [database] = rest;
    if (!database) throw new Error("collect requires <database>");
    await collectInstance(config, database, run);
    return;
  }

  if (command === "export") {
    const [database, outputDir] = rest;
    if (!database || !outputDir) throw new Error("export requires <database> <output-dir>");
    await exportInstance(config, database, outputDir, run);
    return;
  }

  if (command === "schedule") {
    const [database] = rest;
    if (!database) throw new Error("schedule requires <database>");

    const readyFile = process.env.NJU_INFO_READY_FILE;
    const scheduler = createCollectionScheduler({
      schedule: config.collection.schedule,
      timeZone: config.collection.timeZone,
      collect: () => collectInstance(config, database, run),
      onError: (error, trigger) => {
        console.error(`[scheduler] ${trigger} collection failed: ${message(error)}`);
      },
      onSuccess: async (trigger) => {
        if (readyFile) await writeFile(readyFile, `${new Date().toISOString()} ${trigger}\n`);
        console.log(`[scheduler] ${trigger} collection succeeded`);
      },
    });

    console.log(
      `[scheduler] collection schedule ${config.collection.schedule} (${config.collection.timeZone})`,
    );
    const shutdown = waitForShutdown(() => scheduler.stop());
    await scheduler.start();
    await shutdown;
    return;
  }

  throw new Error(`unknown instance command: ${command}`);
}

main().catch((error) => {
  console.error(message(error));
  process.exitCode = 1;
});
