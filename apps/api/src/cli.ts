import process from "node:process";
import { parseArgs } from "./config.js";
import { startApi } from "./server.js";

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const service = await startApi(config);
  console.log(`Listening on http://${config.host}:${config.port}`);

  const shutdown = () => {
    void service.close().then(
      () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
      },
      (failure: unknown) => {
        console.error(failure);
        process.exitCode = 1;
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((failure: unknown) => {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
});
