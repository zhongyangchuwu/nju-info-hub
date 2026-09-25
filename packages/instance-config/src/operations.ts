import { spawn } from "node:child_process";
import type { InstanceConfig } from "./config.js";

export type CommandRunner = (args: string[]) => Promise<void>;

export function createPnpmRunner(cwd: string): CommandRunner {
  return (args) => new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        signal ? `pnpm command terminated by ${signal}` : `pnpm command exited with code ${code ?? "unknown"}`,
      ));
    });
  });
}

export async function collectInstance(
  config: InstanceConfig,
  database: string,
  run: CommandRunner,
): Promise<void> {
  for (const source of config.publication.sources) {
    await run([
      "--filter", "@nju-info/worker", "exec", "tsx", "src/cli.ts", "--",
      "ingest", source.id, database, String(source.limit),
    ]);
  }
}

export async function exportInstance(
  config: InstanceConfig,
  database: string,
  outputDir: string,
  run: CommandRunner,
): Promise<void> {
  const args = [
    "--filter", "@nju-info/api", "exec", "tsx", "src/export-feeds-cli.ts", "--",
    database,
    outputDir,
    ...config.publication.sources.map((source) => source.id),
    "--base-url", config.publication.publicBaseUrl,
  ];
  for (const set of config.publication.sets) {
    args.push("--opml", set.opml, "--set-id", set.id, "--set-title", set.title);
    for (const sourceId of set.sources) args.push("--set-source", sourceId);
  }
  await run(args);
}
