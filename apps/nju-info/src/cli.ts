import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs as parseApiArgs } from "@nju-info/api/config";
import { startApi } from "@nju-info/api/server";
import { loadInstanceConfig } from "@nju-info/instance-config";
import { InfoHubDatabaseReader } from "@nju-info/db";
import { CollectionStageError, diagnoseCollectionError } from "@nju-info/worker/diagnostics";
import { collectInstance, exportInstance } from "./operations.js";
import { createCollectionScheduler } from "./scheduler.js";
import { RuntimeInputError, runtimeInputDiagnostic } from "./runtime-input.js";
import { runSourceCommand } from "./source-command.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "../..");
const embeddedResourceRoot = path.join(packageRoot, "resources");
const resourceRoot = existsSync(embeddedResourceRoot) ? embeddedResourceRoot : repositoryRoot;
const defaultConfig = path.join(resourceRoot, "instances/official.json");
const defaultSourceDir = path.join(resourceRoot, "sources/nju");
const invocationRoot = path.resolve(process.env.INIT_CWD ?? process.cwd());
const snapshotModule = pathToFileURL(path.join(resourceRoot, "scripts/state-snapshot.mjs")).href;

interface SnapshotModule {
  packSnapshot(databasePath: string, archivePath: string): Promise<unknown>;
  verifySnapshot(archivePath: string): Promise<unknown>;
  restoreSnapshot(archivePath: string, databasePath: string): Promise<unknown>;
}


function resolveUserPath(value: string): string {
  return path.resolve(invocationRoot, value);
}

function databasePath(value?: string): string {
  return resolveUserPath(value ?? process.env.NJU_INFO_DB ?? "/data/feeds.sqlite");
}

function configPath(value?: string): string {
  return resolveUserPath(value ?? process.env.NJU_INFO_CONFIG ?? defaultConfig);
}

function sourceDirectory(value?: string): string {
  return resolveUserPath(value ?? process.env.NJU_INFO_SOURCE_DIR ?? defaultSourceDir);
}

function outputDirectory(value?: string): string {
  return resolveUserPath(value ?? process.env.NJU_INFO_OUTPUT ?? "/output");
}

function validateImageRef(): void {
  const ref = process.env.NJU_INFO_IMAGE_REF;
  if (!ref?.startsWith("ghcr.io/zhongyangchuwu/nju-info-hub")) return;
  const repository = "ghcr.io/zhongyangchuwu/nju-info-hub";
  const escaped = repository.replaceAll(".", "\\.");
  const pinnedTag = new RegExp(
    `^${escaped}:(sha-[0-9a-f]{7,40}|v[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$`,
  );
  const digest = new RegExp(`^${escaped}@sha256:[0-9a-f]{64}$`);
  if (!pinnedTag.test(ref) && !digest.test(ref)) {
    throw new RuntimeInputError("invalid_image_ref");
  }
}

async function waitForReady(): Promise<void> {
  const readyFile = process.env.NJU_INFO_READY_FILE;
  if (!readyFile) return;
  const timeout = Number(process.env.NJU_INFO_READY_TIMEOUT_SECONDS ?? "900");
  if (!Number.isInteger(timeout) || timeout < 0) {
    throw new RuntimeInputError("invalid_ready_timeout");
  }
  const { stat } = await import("node:fs/promises");
  for (let elapsed = 0; elapsed <= timeout; elapsed += 1) {
    try {
      if ((await stat(readyFile)).size > 0) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (elapsed === timeout) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`timed out waiting for initial collection readiness: ${readyFile}`);
}

async function waitForShutdown(stop: () => void | Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void Promise.resolve(stop()).then(resolve, reject);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function snapshots(): Promise<SnapshotModule> {
  return await import(snapshotModule) as SnapshotModule;
}

async function runServe(args: string[]): Promise<void> {
  const database = args[0]?.startsWith("--") ? undefined : args[0];
  const flags = database === undefined ? args : args.slice(1);
  await waitForReady();
  const apiArgs = [databasePath(database)];
  if (!flags.includes("--host")) {
    apiArgs.push("--host", process.env.NJU_INFO_HOST ?? "127.0.0.1");
  }
  if (!flags.includes("--port")) {
    apiArgs.push("--port", process.env.NJU_INFO_PORT ?? "3000");
  }
  apiArgs.push(...flags);
  const api = parseApiArgs(apiArgs);
  const service = await startApi(api);
  console.log(`Listening on http://${api.host}:${api.port}`);
  await waitForShutdown(() => service.close());
}

async function loadRuntimeConfig(config?: string, sourceDir?: string) {
  const resolvedSourceDir = sourceDirectory(sourceDir);
  const resolvedConfig = configPath(config);
  return {
    config: await loadInstanceConfig(resolvedConfig, resolvedSourceDir),
    sourceDir: resolvedSourceDir,
  };
}

async function runValidate(args: string[]): Promise<void> {
  if (args.length > 2) throw new RuntimeInputError("usage_validate");
  await loadRuntimeConfig(args[0], args[1]);
}

async function runCollect(args: string[]): Promise<void> {
  if (args.length > 3) {
    throw new RuntimeInputError("usage_collect");
  }
  const runtime = await loadRuntimeConfig(args[0], args[1]);
  await collectInstance(runtime.config, databasePath(args[2]), runtime.sourceDir);
}
async function runStatus(args: string[]): Promise<void> {
  if (args.length > 1) throw new RuntimeInputError("usage_status");
  const reader = new InfoHubDatabaseReader(databasePath(args[0]));
  try {
    console.log(JSON.stringify({
      runs: reader.listCollectionRuns(),
      sources: reader.listCollectionSourceStatuses(),
    }, null, 2));
  } finally {
    reader.close();
  }
}


async function runExport(args: string[]): Promise<void> {
  if (args.length > 4) {
    throw new RuntimeInputError("usage_export");
  }
  const runtime = await loadRuntimeConfig(args[0], args[1]);
  await exportInstance(
    runtime.config,
    databasePath(args[2]),
    outputDirectory(args[3]),
  );
}

async function runSchedule(args: string[]): Promise<void> {
  if (args.length > 3) {
    throw new RuntimeInputError("usage_schedule");
  }
  const runtime = await loadRuntimeConfig(args[0], args[1]);
  const readyFile = process.env.NJU_INFO_READY_FILE;
  const scheduler = createCollectionScheduler({
    schedule: runtime.config.collection.schedule,
    timeZone: runtime.config.collection.timeZone,
    collect: async (trigger) => {
      await collectInstance(runtime.config, databasePath(args[2]), runtime.sourceDir, trigger);
    },
    onError: (error, trigger) => {
      console.error(JSON.stringify({
        event: "scheduler.failed", trigger, at: new Date().toISOString(),
        error: diagnoseCollectionError(error),
      }));
    },
    onSuccess: async (trigger) => {
      if (readyFile) {
        try {
          await writeFile(readyFile, `${new Date().toISOString()} ${trigger}\n`);
        } catch (error) {
          throw new CollectionStageError("persistence", error);
        }
      }
      console.log(JSON.stringify({ event: "scheduler.completed", trigger, at: new Date().toISOString() }));
    },
  });

  console.log(JSON.stringify({
    event: "scheduler.started", schedule: runtime.config.collection.schedule,
    timeZone: runtime.config.collection.timeZone, at: new Date().toISOString(),
  }));
  const shutdown = waitForShutdown(() => scheduler.stop());
  await scheduler.start();
  await shutdown;
}

async function runBackup(args: string[]): Promise<void> {
  if (args.length < 1 || args.length > 2) {
    throw new RuntimeInputError("usage_backup");
  }
  const snapshot = await snapshots();
  const snapshotPath = resolveUserPath(args[0]!);
  await snapshot.packSnapshot(databasePath(args[1]), snapshotPath);
  await snapshot.verifySnapshot(snapshotPath);
  console.log(`verified backup: ${snapshotPath}`);
}

async function runRestore(args: string[]): Promise<void> {
  if (args.length < 1 || args.length > 2) {
    throw new RuntimeInputError("usage_restore");
  }
  const snapshotPath = resolveUserPath(args[0]!);
  await (await snapshots()).restoreSnapshot(snapshotPath, databasePath(args[1]));
  const readyFile = process.env.NJU_INFO_READY_FILE;
  if (readyFile) await writeFile(readyFile, `${new Date().toISOString()} restore\n`);
  console.log(`restored backup: ${snapshotPath}`);
}

async function runVerifyBackup(args: string[]): Promise<void> {
  if (args.length !== 1) {
    throw new RuntimeInputError("usage_verify_backup");
  }
  console.log(JSON.stringify(await (await snapshots()).verifySnapshot(resolveUserPath(args[0]!))));
}

export async function main(argv: string[]): Promise<void> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const command = args.shift() ?? "serve";
  validateImageRef();

  switch (command) {
    case "serve":
      await runServe(args);
      return;
    case "validate":
      await runValidate(args);
      return;
    case "collect":
      await runCollect(args);
      return;
    case "status":
      await runStatus(args);
      return;
    case "schedule":
      await runSchedule(args);
      return;
    case "export":
      await runExport(args);
      return;
    case "backup":
      await runBackup(args);
      return;
    case "restore":
      await runRestore(args);
      return;
    case "verify-backup":
      await runVerifyBackup(args);
      return;
    case "source":
      await runSourceCommand(args, sourceDirectory(), invocationRoot);
      return;
    default:
      throw new RuntimeInputError("unknown_command");
  }
}

const invokedDirectly = process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    const input = runtimeInputDiagnostic(error);
    console.error(JSON.stringify({
      event: "runtime.failed", at: new Date().toISOString(), error: diagnoseCollectionError(error),
      ...(input === undefined ? {} : { input }),
    }));
    process.exitCode = 1;
  });
}
