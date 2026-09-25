#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";

const SNAPSHOT_FORMAT = "nju-info-state-snapshot";
const SNAPSHOT_VERSION = 1;
const DATABASE_ENTRY = "feeds.sqlite";
const MANIFEST_ENTRY = "manifest.json";

function runTar(args) {
  const result = spawnSync("tar", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "tar failed").trim();
    throw new Error(detail);
  }
  return result.stdout;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function pragmaScalar(database, pragma, field) {
  const row = database.prepare(pragma).get();
  return row?.[field];
}

export function verifyDatabase(path) {
  const database = new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  try {
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    if (
      integrityRows.length !== 1 ||
      integrityRows[0]?.integrity_check !== "ok"
    ) {
      throw new Error("SQLite integrity_check failed");
    }
    const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyRows.length !== 0) {
      throw new Error("SQLite foreign_key_check failed");
    }
    return Number(pragmaScalar(database, "PRAGMA user_version", "user_version") ?? 0);
  } finally {
    database.close();
  }
}

async function inspectArchive(archivePath) {
  const listed = runTar(["-tzf", archivePath])
    .split("\n")
    .map((entry) => entry.replace(/^\.\//, ""))
    .filter(Boolean);
  const expected = [DATABASE_ENTRY, MANIFEST_ENTRY].sort();
  const actual = [...listed].sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(
      `snapshot archive must contain exactly ${expected.join(", ")}`,
    );
  }

  const directory = await fs.mkdtemp(join(tmpdir(), "nju-info-state-"));
  try {
    runTar(["-xzf", archivePath, "-C", directory]);
    const manifestPath = join(directory, MANIFEST_ENTRY);
    const databasePath = join(directory, DATABASE_ENTRY);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

    if (
      manifest?.format !== SNAPSHOT_FORMAT ||
      manifest?.version !== SNAPSHOT_VERSION ||
      manifest?.database !== DATABASE_ENTRY ||
      manifest?.sha256_algorithm !== "sha256" ||
      typeof manifest?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest?.size_bytes) ||
      manifest.size_bytes < 0 ||
      !Number.isSafeInteger(manifest?.schema_version) ||
      manifest.schema_version < 0
    ) {
      throw new Error("invalid snapshot manifest");
    }

    const stat = await fs.stat(databasePath);
    if (!stat.isFile() || stat.size !== manifest.size_bytes) {
      throw new Error("snapshot database size does not match manifest");
    }
    const checksum = await sha256File(databasePath);
    if (checksum !== manifest.sha256) {
      throw new Error("snapshot database checksum does not match manifest");
    }
    const schemaVersion = verifyDatabase(databasePath);
    if (schemaVersion !== manifest.schema_version) {
      throw new Error("snapshot database schema version does not match manifest");
    }

    return { directory, databasePath, manifest };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function packSnapshot(databasePath, archivePath) {
  const sourceStat = await fs.stat(databasePath);
  if (!sourceStat.isFile()) {
    throw new Error("snapshot source must be a SQLite file");
  }

  await fs.mkdir(dirname(archivePath), { recursive: true });
  const directory = await fs.mkdtemp(join(tmpdir(), "nju-info-state-pack-"));
  const snapshotDatabase = join(directory, DATABASE_ENTRY);
  const temporaryArchive = join(
    dirname(archivePath),
    `.${basename(archivePath)}.tmp-${process.pid}-${Date.now()}`,
  );

  try {
    const source = new DatabaseSync(databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    try {
      await backup(source, snapshotDatabase);
    } finally {
      source.close();
    }

    const schemaVersion = verifyDatabase(snapshotDatabase);
    const stat = await fs.stat(snapshotDatabase);
    const manifest = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      database: DATABASE_ENTRY,
      sha256_algorithm: "sha256",
      sha256: await sha256File(snapshotDatabase),
      size_bytes: stat.size,
      schema_version: schemaVersion,
    };
    await fs.writeFile(
      join(directory, MANIFEST_ENTRY),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );

    runTar([
      "--format=ustar",
      "-czf",
      temporaryArchive,
      "-C",
      directory,
      MANIFEST_ENTRY,
      DATABASE_ENTRY,
    ]);
    await fs.rename(temporaryArchive, archivePath);
    return manifest;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(temporaryArchive, { force: true });
  }
}

export async function verifySnapshot(archivePath) {
  const inspected = await inspectArchive(archivePath);
  try {
    return inspected.manifest;
  } finally {
    await fs.rm(inspected.directory, { recursive: true, force: true });
  }
}

export async function restoreSnapshot(archivePath, databasePath) {
  const inspected = await inspectArchive(archivePath);
  const targetDirectory = dirname(databasePath);
  await fs.mkdir(targetDirectory, { recursive: true });
  const temporaryDatabase = join(
    targetDirectory,
    `.${basename(databasePath)}.restore-${process.pid}-${Date.now()}`,
  );

  try {
    await fs.copyFile(inspected.databasePath, temporaryDatabase);
    const handle = await fs.open(temporaryDatabase, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryDatabase, databasePath);
    await Promise.all([
      fs.rm(`${databasePath}-wal`, { force: true }),
      fs.rm(`${databasePath}-shm`, { force: true }),
    ]);
    return inspected.manifest;
  } finally {
    await fs.rm(temporaryDatabase, { force: true });
    await fs.rm(inspected.directory, { recursive: true, force: true });
  }
}

function usage() {
  return [
    "usage:",
    "  state-snapshot pack <database-path> <snapshot.tar.gz>",
    "  state-snapshot verify <snapshot.tar.gz>",
    "  state-snapshot restore <snapshot.tar.gz> <database-path>",
  ].join("\n");
}

async function main(argv) {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, first, second, ...extra] = normalizedArgv;
  if (extra.length > 0) throw new Error(usage());

  if (command === "pack" && first && second) {
    const manifest = await packSnapshot(first, second);
    console.log(JSON.stringify(manifest));
    return;
  }
  if (command === "verify" && first && !second) {
    const manifest = await verifySnapshot(first);
    console.log(JSON.stringify(manifest));
    return;
  }
  if (command === "restore" && first && second) {
    const manifest = await restoreSnapshot(first, second);
    console.log(JSON.stringify(manifest));
    return;
  }
  throw new Error(usage());
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
