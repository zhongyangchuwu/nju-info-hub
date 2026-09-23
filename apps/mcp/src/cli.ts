import process from "node:process";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { InfoHubDatabaseReader } from "@nju-info/db";
import { createMcpServer } from "./server.js";

function databasePath(argv: string[]): string {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length !== 1 || !args[0] || args[0].startsWith("--")) {
    throw new Error("usage: mcp <database-path>");
  }
  return resolve(args[0]);
}

function main(): void {
  const path = databasePath(process.argv.slice(2));
  // Validate the database before accepting protocol input. The first connection uses this reader.
  const readers = new Set<InfoHubDatabaseReader>([new InfoHubDatabaseReader(path)]);
  let initialReader = readers.values().next().value;
  const closeReaders = () => {
    for (const reader of readers) reader.close();
    readers.clear();
  };
  let handle;
  try {
    handle = serveStdio(() => {
      const reader = initialReader ?? new InfoHubDatabaseReader(path);
      initialReader = undefined;
      readers.add(reader);
      return createMcpServer(reader, () => {
        reader.close();
        readers.delete(reader);
      });
    }, { onerror: () => console.error("MCP transport error") });
  } catch (failure) {
    closeReaders();
    throw failure;
  }
  const shutdown = () => {
    void handle.close().then(closeReaders, () => {
      console.error("MCP shutdown error");
      process.exitCode = 1;
      closeReaders();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  process.once("exit", closeReaders);
}

try {
  main();
} catch (failure) {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
}
