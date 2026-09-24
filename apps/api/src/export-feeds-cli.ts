import { resolve } from "node:path";
import process from "node:process";
import { InfoHubDatabaseReader } from "@nju-info/db";
import { exportFeeds } from "./export-feeds.js";

async function main(args: string[]): Promise<void> {
  const argv = args[0] === "--" ? args.slice(1) : args;
  const [databasePath, outputDirectory, ...rest] = argv;
  const usage = "usage: export-feeds <database-path> <output-dir> [source-id ...] [--base-url <url>] [--opml <relative-path>] [--set-id <id> --set-title <title>]";
  if (!databasePath || !outputDirectory || databasePath.startsWith("--") || outputDirectory.startsWith("--")) {
    throw new Error(usage);
  }
  const sourceIds: string[] = [];
  let publicBaseUrl: string | undefined;
  let opmlPath: string | undefined;
  let sourceSetId: string | undefined;
  let sourceSetTitle: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]!;
    if (value === "--base-url" || value === "--opml" || value === "--set-id" || value === "--set-title") {
      const argument = rest[++index];
      if (!argument || argument.startsWith("--")) throw new Error(usage);
      if (value === "--base-url") {
        if (publicBaseUrl !== undefined) throw new Error("duplicate --base-url");
        publicBaseUrl = argument;
      } else if (value === "--opml") {
        if (opmlPath !== undefined) throw new Error("duplicate --opml");
        opmlPath = argument;
      } else if (value === "--set-id") {
        if (sourceSetId !== undefined) throw new Error("duplicate --set-id");
        sourceSetId = argument;
      } else {
        if (sourceSetTitle !== undefined) throw new Error("duplicate --set-title");
        sourceSetTitle = argument;
      }
    } else if (value.startsWith("--")) {
      throw new Error("unknown option: " + value);
    } else {
      sourceIds.push(value);
    }
  }
  if ((sourceSetId === undefined) !== (sourceSetTitle === undefined)) {
    throw new Error("--set-id and --set-title must be provided together");
  }

  const reader = new InfoHubDatabaseReader(resolve(databasePath));
  try {
    await exportFeeds(reader, resolve(outputDirectory), sourceIds.length ? sourceIds : undefined, {
      ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
      ...(opmlPath === undefined ? {} : { opmlPath }),
      ...(sourceSetId === undefined || sourceSetTitle === undefined
        ? {}
        : { sourceSet: { id: sourceSetId, title: sourceSetTitle } }),
    });
  } finally {
    reader.close();
  }
}

main(process.argv.slice(2)).catch((failure: unknown) => {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
});
