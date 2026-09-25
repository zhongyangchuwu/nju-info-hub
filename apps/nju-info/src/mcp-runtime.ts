import process from "node:process";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { InfoHubDatabaseReader } from "@nju-info/db";
import { createMcpServer } from "@nju-info/mcp/server";

export function serveMcp(databasePath: string): void {
  const readers = new Set<InfoHubDatabaseReader>([
    new InfoHubDatabaseReader(databasePath),
  ]);
  let initialReader = readers.values().next().value;

  const closeReaders = () => {
    for (const reader of readers) reader.close();
    readers.clear();
  };

  let handle;
  try {
    handle = serveStdio(() => {
      const reader = initialReader ?? new InfoHubDatabaseReader(databasePath);
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
