#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: docker-smoke.sh <image>}"
suffix="${GITHUB_RUN_ID:-local}-$$"
volume="nju-info-hub-smoke-${suffix}"
container="nju-info-hub-smoke-${suffix}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$volume" >/dev/null

docker run --rm "$image"   pnpm instance -- validate instances/official.json sources/nju

docker run --rm -v "$volume:/data" "$image"   tsx -e 'import { InfoHubDatabase } from "@nju-info/db"; const db = new InfoHubDatabase("/data/feeds.sqlite"); db.close();'

wait_healthy() {
  for _ in $(seq 1 20); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
    case "$status" in
      healthy) return 0 ;;
      unhealthy)
        docker logs "$container" >&2
        return 1
        ;;
    esac
    sleep 1
  done
  docker logs "$container" >&2
  echo "container did not become healthy" >&2
  return 1
}

start_api() {
  docker run -d --name "$container" -v "$volume:/data:ro" "$image" >/dev/null
  wait_healthy
  docker rm -f "$container" >/dev/null
}

start_api
start_api
