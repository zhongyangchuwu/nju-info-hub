import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  packSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "./state-snapshot.mjs";

function createDatabase(path, value) {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("CREATE TABLE state (value TEXT NOT NULL)");
    database.prepare("INSERT INTO state (value) VALUES (?)").run(value);
    database.exec("PRAGMA user_version = 7");
  } finally {
    database.close();
  }
}

function readValue(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare("SELECT value FROM state").get().value;
  } finally {
    database.close();
  }
}

test("packs, verifies, and restores a self-contained SQLite snapshot", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "nju-info-state-test-"));
  try {
    const source = join(directory, "source.sqlite");
    const archive = join(directory, "state.tar.gz");
    const restored = join(directory, "restored.sqlite");
    createDatabase(source, "current");

    const packed = await packSnapshot(source, archive);
    assert.equal(packed.schema_version, 7);
    assert.match(packed.sha256, /^[a-f0-9]{64}$/);

    const entries = execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(entries, ["feeds.sqlite", "manifest.json"]);

    const verified = await verifySnapshot(archive);
    assert.deepEqual(verified, packed);

    await restoreSnapshot(archive, restored);
    assert.equal(readValue(restored), "current");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a checksum-invalid snapshot cannot replace existing local state", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "nju-info-state-test-"));
  try {
    const source = join(directory, "source.sqlite");
    const validArchive = join(directory, "valid.tar.gz");
    const unpacked = join(directory, "unpacked");
    const corruptedArchive = join(directory, "corrupted.tar.gz");
    const target = join(directory, "target.sqlite");

    createDatabase(source, "new");
    createDatabase(target, "old");
    await packSnapshot(source, validArchive);

    await fs.mkdir(unpacked);
    execFileSync("tar", ["-xzf", validArchive, "-C", unpacked]);
    await fs.appendFile(join(unpacked, "feeds.sqlite"), Buffer.from([0]));
    execFileSync("tar", [
      "--format=ustar",
      "-czf",
      corruptedArchive,
      "-C",
      unpacked,
      "manifest.json",
      "feeds.sqlite",
    ]);

    await assert.rejects(
      restoreSnapshot(corruptedArchive, target),
      /size does not match manifest|checksum does not match manifest/,
    );
    assert.equal(readValue(target), "old");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects archives with unexpected entries", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "nju-info-state-test-"));
  try {
    const source = join(directory, "source.sqlite");
    const archive = join(directory, "state.tar.gz");
    const unpacked = join(directory, "unpacked");
    const unsafeArchive = join(directory, "unsafe.tar.gz");
    createDatabase(source, "value");
    await packSnapshot(source, archive);

    await fs.mkdir(unpacked);
    execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
    await fs.writeFile(join(unpacked, "extra.txt"), "unexpected\n");
    execFileSync("tar", [
      "--format=ustar",
      "-czf",
      unsafeArchive,
      "-C",
      unpacked,
      "manifest.json",
      "feeds.sqlite",
      "extra.txt",
    ]);

    await assert.rejects(
      verifySnapshot(unsafeArchive),
      /must contain exactly/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
