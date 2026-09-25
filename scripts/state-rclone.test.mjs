import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/state-rclone.sh");

async function fakeRclone(directory) {
  const bin = join(directory, "bin");
  await fs.mkdir(bin);
  const path = join(bin, "rclone");
  await fs.writeFile(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
command_name="$1"
shift
case "$command_name" in
  copyto)
    source_path="$1"
    destination_path="$2"
    mkdir -p "$(dirname "$destination_path")"
    cp "$source_path" "$destination_path"
    if [[ "${FAKE_RCLONE_CORRUPT_DOWNLOAD:-0}" == "1" && "$source_path" == *.tmp-* ]]; then
      printf 'corrupt' >> "$destination_path"
    fi
    ;;
  moveto)
    source_path="$1"
    destination_path="$2"
    mkdir -p "$(dirname "$destination_path")"
    mv -f "$source_path" "$destination_path"
    ;;
  deletefile)
    rm -f "$1"
    ;;
  *)
    echo "unsupported fake rclone command: $command_name" >&2
    exit 2
    ;;
esac
`,
    "utf8",
  );
  await fs.chmod(path, 0o755);
  return bin;
}

function run(args, env) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env,
  });
}

test("uploads through a temporary remote object and restores it", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "nju-info-rclone-test-"));
  try {
    const bin = await fakeRclone(directory);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NJU_INFO_STATE_UPLOAD_ID: "test",
    };
    const local = join(directory, "local.tar.gz");
    const remote = join(directory, "remote", "current.tar.gz");
    const restored = join(directory, "restore", "state.tar.gz");
    await fs.writeFile(local, "snapshot-bytes");

    const upload = run(["upload", local, remote], env);
    assert.equal(upload.status, 0, upload.stderr);
    assert.equal(await fs.readFile(remote, "utf8"), "snapshot-bytes");
    await assert.rejects(
      fs.stat(`${remote}.tmp-test`),
      (error) => error?.code === "ENOENT",
    );

    const restore = run(["restore", remote, restored], env);
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(await fs.readFile(restored, "utf8"), "snapshot-bytes");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("failed upload verification leaves the current remote snapshot unchanged", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "nju-info-rclone-test-"));
  try {
    const bin = await fakeRclone(directory);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NJU_INFO_STATE_UPLOAD_ID: "test",
      FAKE_RCLONE_CORRUPT_DOWNLOAD: "1",
    };
    const local = join(directory, "local.tar.gz");
    const remote = join(directory, "remote", "current.tar.gz");
    await fs.mkdir(join(directory, "remote"));
    await fs.writeFile(local, "new-snapshot");
    await fs.writeFile(remote, "old-snapshot");

    const upload = run(["upload", local, remote], env);
    assert.notEqual(upload.status, 0);
    assert.match(upload.stderr, /failed byte-for-byte verification/);
    assert.equal(await fs.readFile(remote, "utf8"), "old-snapshot");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("missing remote restore exits with the cache-fallback status", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "nju-info-rclone-test-"));
  try {
    const bin = await fakeRclone(directory);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
    };
    const missing = join(directory, "missing.tar.gz");
    const restored = join(directory, "restore.tar.gz");

    const result = run(["restore", missing, restored], env);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /cache fallback may be used/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
