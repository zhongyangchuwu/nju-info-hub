# Durable state storage

NJU Info Hub runs SQLite on the local filesystem of the active runner or host. Remote
storage is used only for verified snapshots; WebDAV is never mounted as the live
SQLite filesystem.

## State layers

The public Pages deployment has two independent state layers:

1. GitHub Actions cache — best-effort warm-start cache.
2. Durable snapshot storage — optional source of truth for resuming collection.

When durable storage is configured, the workflow restores it first. If the remote
snapshot is missing, unreachable, or fails local verification, the workflow falls
back to the Actions cache. Collection must still be able to rebuild from public
upstreams if both are unavailable.

After collection and feed export, the workflow saves the best-effort Actions cache,
creates a new verified snapshot, and uploads it to durable storage. A configured
durable upload failure fails the build before the Pages artifact is uploaded, so the
previous public deployment remains in place.

## Snapshot format

`scripts/state-snapshot.mjs` creates one `.tar.gz` artifact containing exactly:

- `feeds.sqlite` — a standalone database produced with Node's SQLite backup API;
- `manifest.json` — format/version metadata, database size, schema version, and
  SHA-256 checksum.

The source database may use WAL mode. The snapshot tool does not copy the live
`-wal` or `-shm` files; SQLite's backup API produces a consistent standalone
database.

Restore verifies, in order:

1. the archive contains only the two expected files;
2. manifest shape/version;
3. database byte size;
4. SHA-256;
5. SQLite `integrity_check`;
6. SQLite `foreign_key_check`;
7. schema version recorded by the manifest.

Only after all checks pass is the target database replaced. Stale target WAL/SHM
sidecars are removed after replacement.

### Local snapshot commands

```bash
pnpm state:snapshot -- pack .cache/nju-info/feeds.sqlite /tmp/nju-info-state.tar.gz
pnpm state:snapshot -- verify /tmp/nju-info-state.tar.gz
pnpm state:snapshot -- restore /tmp/nju-info-state.tar.gz .cache/nju-info/feeds.sqlite
```

## Generic rclone transport

`scripts/state-rclone.sh` deliberately knows nothing about WebDAV. It accepts any
rclone source/destination syntax supported by the user's installed rclone.

Upload uses a temporary remote name, downloads that temporary object again for a
byte-for-byte comparison, then moves it over the current snapshot. A failed
verification leaves the previous current snapshot untouched.

```bash
RCLONE_CONFIG="$HOME/.config/rclone/rclone.conf" \
  bash scripts/state-rclone.sh upload \
  /tmp/nju-info-state.tar.gz myremote:nju-info-hub/state/current.tar.gz

RCLONE_CONFIG="$HOME/.config/rclone/rclone.conf" \
  bash scripts/state-rclone.sh restore \
  myremote:nju-info-hub/state/current.tar.gz /tmp/restored-state.tar.gz
```

This makes local filesystem, WebDAV, S3, Google Drive, OneDrive, Seafile and other
rclone backends future deployment choices without changing collector/database code.

## GitHub Pages WebDAV configuration

The official Pages workflow only configures WebDAV in this first milestone. Durable
state is disabled when all three WebDAV secrets are absent.

Repository secrets:

- `NJU_INFO_STATE_WEBDAV_URL`
- `NJU_INFO_STATE_WEBDAV_USER`
- `NJU_INFO_STATE_WEBDAV_PASSWORD`

Optional repository variables:

- `NJU_INFO_STATE_WEBDAV_VENDOR` — defaults to `other`;
- `NJU_INFO_STATE_REMOTE_PATH` — defaults to
  `nju-info-hub/state/current.tar.gz`.

If only some of the required secrets are configured, the workflow fails rather than
silently pretending durable storage is enabled.

At runtime the workflow:

1. installs rclone only when durable state is configured;
2. creates an ephemeral rclone config under `$RUNNER_TEMP` with mode `0600`;
3. obscures the password before writing the temporary config;
4. restores and verifies the remote snapshot;
5. falls back to Actions cache if restore/verification fails;
6. collects/exports using local SQLite;
7. saves the Actions cache;
8. creates and uploads a verified durable snapshot;
9. uploads/deploys Pages only after durable upload succeeds.

The temporary rclone config and snapshot live under runner temporary storage. They
are not included in the Actions cache or Pages artifact.

## Security boundary

Durable public-state storage contains only the public collector database. It must not
contain:

- NJU SSO credentials;
- personal sessions/cookies;
- private QQ/WeChat state;
- future private-sidecar databases.

Private/user-owned deployment state will use separate storage and credential
boundaries.

## NJU Box / Seafile

NJU Box or another Seafile deployment can be a user-selected durable backend when it
exposes a usable WebDAV endpoint. It is not hard-coded into NJU Info Hub.

The generic rclone transport also leaves room for a future native rclone Seafile
profile. Provider-specific configuration belongs to deployment profiles, not the
collector or canonical data model.
