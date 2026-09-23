import { resolve } from "node:path";
import process from "node:process";
import { InfoHubDatabaseReader } from "@nju-info/db";
import { exportFeeds } from "./export-feeds.js";

async function main(args: string[]): Promise<void> {
  const argv = args[0] === "--" ? args.slice(1) : args;
  const [databasePath, outputDirectory, ...rest] = argv;
  const usage = "usage: export-feeds <database-path> <output-dir> [source-id ...] [--base-url <url>] [--opml <relative-path>]";
  if (!databasePath || !outputDirectory || databasePath.startsWith("--") || outputDirectory.startsWith("--")) {
    throw new Error(usage);
  }
  const sourceIds: string[] = [];
  let publicBaseUrl: string | undefined;
  let opmlPath: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]!;
    if (value === "--base-url" || value === "--opml") {
      const argument = rest[++index];
      if (!argument || argument.startsWith("--")) throw new Error(usage);
      if (value === "--base-url") {
        if (publicBaseUrl !== undefined) throw new Error("duplicate --base-url");
        publicBaseUrl = argument;
      } else {
        if (opmlPath !== undefined) throw new Error("duplicate --opml");
        opmlPath = argument;
      }
    } else if (value.startsWith("--")) {
      throw new Error(`unknown option: ${value}`);
    } else {
      sourceIds.push(value);
    }
  }
  const reader = new InfoHubDatabaseReader(resolve(databasePath));
  try {
    await exportFeeds(reader, resolve(outputDirectory), sourceIds.length ? sourceIds : undefined,
      { ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }), ...(opmlPath === undefined ? {} : { opmlPath }) });
  } finally {
    reader.close();
  }
}

main(process.argv.slice(2)).catch((failure: unknown) => {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
});
