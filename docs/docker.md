# Docker / GHCR

The official container is a public-data-only runtime for NJU Info Hub. It does not contain or request NJU SSO credentials, personal cookies, QQ/WeChat sessions, or private campus data.

## Image

Images are published to:

```text
ghcr.io/zhongyangchuwu/nju-info-hub
```

The container workflow publishes immutable revision tags in the form `sha-<short-sha>`. A Git tag such as `v1.2.3` also publishes the matching version tag. The workflow deliberately does not publish an implicit `latest` tag.

The image uses Node 26 and the repository-pinned pnpm/tsx versions. It runs as the unprivileged `node` user.

## Runtime model

One image exposes existing repository commands:

- default command: read-only HTTP API on port 3000;
- `pnpm instance -- validate ...`: validate deployment configuration;
- `pnpm instance -- collect ...`: collect configured public sources into local SQLite;
- `pnpm worker -- ...`: lower-level public collector commands.

SQLite remains on the active host/container volume. The API opens an existing current-schema database read-only and does not create or migrate state.

## Localhost Compose profile

Set an immutable image reference:

```bash
export NJU_INFO_IMAGE=ghcr.io/zhongyangchuwu/nju-info-hub:sha-<revision>
```

For local development, a locally built tag can be used instead:

```bash
docker build -t nju-info-hub:local .
export NJU_INFO_IMAGE=nju-info-hub:local
```

The Compose file is `deploy/docker/localhost/compose.yaml`.

First create/update the local SQLite state with the public collector:

```bash
docker compose -f deploy/docker/localhost/compose.yaml run --rm collect
```

Then start the read-only API:

```bash
docker compose -f deploy/docker/localhost/compose.yaml up -d api
```

It is bound to `127.0.0.1:3000` by default. Override the host port only:

```bash
NJU_INFO_PORT=3100 docker compose -f deploy/docker/localhost/compose.yaml up -d api
```

Health endpoint:

```text
http://127.0.0.1:3000/v1/health
```

Stop the API without deleting state:

```bash
docker compose -f deploy/docker/localhost/compose.yaml down
```

The named volume `nju-info-data` remains. Removing the volume is a destructive state reset and is intentionally not part of the normal stop/upgrade flow.

## Configuration

The localhost profile mounts the repository's `instances/official.json` into the one-shot collector as `/config/instance.json`. The image contains the source registry and validates the mounted instance configuration before collection.

A later deployment-template milestone will make user-owned config/version pins the product onboarding path. This profile intentionally does not introduce that template yet.

## Upgrade

1. Choose a new immutable GHCR revision/version tag.
2. Update `NJU_INFO_IMAGE`.
3. Run the one-shot collector if you want fresh state.
4. Recreate the API:

```bash
docker compose -f deploy/docker/localhost/compose.yaml pull api
docker compose -f deploy/docker/localhost/compose.yaml up -d api
```

The named SQLite volume is preserved across container recreation.

## Security boundary

- no secrets are baked into the image;
- API state is mounted read-only;
- collection writes only to the local named volume;
- the official profile collects public sources only;
- SQLite is not placed on WebDAV/FUSE/network mounts;
- private authentication/session support is out of scope for this image milestone.
