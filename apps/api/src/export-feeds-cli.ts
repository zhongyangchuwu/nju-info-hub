import { resolve } from "node:path";
import process from "node:process";
import { InfoHubDatabaseReader } from "@nju-info/db";
import { exportFeeds } from "./export-feeds.js";

async function main(args: string[]): Promise<void> {
  const [databasePath, outputDirectory, ...sourceIds] = args[0] === "--" ? args.slice(1) : args;
  if (!databasePath || !outputDirectory) {
    throw new Error("usage: export-feeds <database-path> <output-dir> [source-id ...]");
  }

  const reader = new InfoHubDatabaseReader(resolve(databasePath));
  try {
    await exportFeeds(reader, resolve(outputDirectory), sourceIds.length ? sourceIds : undefined);
  } finally {
    reader.close();
  }
}

main(process.argv.slice(2)).catch((failure: unknown) => {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
});
