import { resolve } from "node:path";

export interface ApiConfig {
  databasePath: string;
  host: string;
  port: number;
}

export function parseArgs(argv: string[]): ApiConfig {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [path, ...flags] = args;
  if (!path || path.startsWith("--")) {
    throw new Error("usage: api <database-path> [--host <host>] [--port <port>]");
  }

  let host = "127.0.0.1";
  let port = 3000;
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!flag || !["--host", "--port"].includes(flag) || seen.has(flag) ||
        value === undefined || value.startsWith("--")) {
      throw new Error("usage: api <database-path> [--host <host>] [--port <port>]");
    }
    seen.add(flag);
    if (flag === "--host") {
      if (!value.trim()) throw new Error("host must be nonempty");
      host = value;
    } else {
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 65535) {
        throw new Error("port must be a decimal integer from 1 to 65535");
      }
      port = Number(value);
    }
  }
  return { databasePath: resolve(path), host, port };
}
