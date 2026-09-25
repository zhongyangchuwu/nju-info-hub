#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: docker-smoke.sh <image>}"
suffix="${GITHUB_RUN_ID:-local}-$$"
network="nju-info-hub-smoke-${suffix}"
volume="nju-info-hub-smoke-${suffix}"
fixture="nju-info-fixture-${suffix}"
scheduler="nju-info-scheduler-${suffix}"
api="nju-info-api-${suffix}"
tmpdir="$(mktemp -d)"

cleanup() {
  docker rm -f "$api" "$scheduler" "$fixture" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$tmpdir"
}
trap cleanup EXIT

mkdir -p "$tmpdir/sources" "$tmpdir/site"

cat > "$tmpdir/sources/smoke-source.yaml" <<'YAML'
schemaVersion: 1
id: smoke-source
name: Smoke Source
organization:
  id: smoke-org
  name: Smoke Organization
url: http://fixture:8080/list.htm
adapter:
  type: webplus
enabled: true
YAML

cat > "$tmpdir/instance.json" <<'JSON'
{
  "schemaVersion": 2,
  "instance": { "id": "smoke", "name": "Smoke Instance" },
  "publication": {
    "publicBaseUrl": "http://localhost:3000/",
    "sources": [{ "id": "smoke-source", "limit": 1 }],
    "sets": []
  },
  "collection": {
    "schedule": "0 0 1 1 *",
    "timeZone": "UTC"
  },
  "storage": { "mode": "cache-only" }
}
JSON

cat > "$tmpdir/site/list.html" <<'HTML'
<ul class="news_list">
  <li>
    <a href="/a/page.htm" title="Smoke notice">Smoke notice</a>
    <span class="news_meta">2026-09-25</span>
  </li>
</ul>
HTML

cat > "$tmpdir/site/detail.html" <<'HTML'
<article>
  <h1 class="arti_title">Smoke notice</h1>
  <span class="arti_update">发布时间：2026-09-25</span>
  <div class="wp_articlecontent"><p>Container scheduler smoke content.</p></div>
</article>
HTML

docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null

docker run -d --name "$fixture" --network "$network" \
  --network-alias fixture \
  --entrypoint node \
  -v "$tmpdir/site:/site:ro" \
  "$image" \
  -e 'const http=require("node:http"),fs=require("node:fs"); http.createServer((req,res)=>{const file=req.url==="/list.htm"?"/site/list.html":req.url==="/a/page.htm"?"/site/detail.html":null;if(!file){res.statusCode=404;return res.end("not found")}res.setHeader("content-type","text/html; charset=utf-8");res.end(fs.readFileSync(file))}).listen(8080,"0.0.0.0")' \
  >/dev/null

docker run -d --name "$scheduler" --network "$network" --no-healthcheck \
  -v "$volume:/data" \
  -v "$tmpdir:/config:ro" \
  -e NJU_INFO_CONFIG=/config/instance.json \
  -e NJU_INFO_SOURCE_DIR=/config/sources \
  -e NJU_INFO_READY_FILE=/data/.collection-ready \
  "$image" schedule >/dev/null

start_api() {
  docker run -d --name "$api" --network "$network" \
    -v "$volume:/data" \
    -e NJU_INFO_READY_FILE=/data/.collection-ready \
    -e NJU_INFO_READY_TIMEOUT_SECONDS=60 \
    "$image" serve >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 60); do
    if ! docker inspect "$api" >/dev/null 2>&1; then
      echo "API container disappeared" >&2
      return 1
    fi
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$api")"
    case "$status" in
      healthy) return 0 ;;
      unhealthy)
        if [ "$(docker inspect --format '{{.State.Status}}' "$scheduler")" = "exited" ]; then
          docker logs "$scheduler" >&2
          return 1
        fi
        ;;
    esac
    sleep 1
  done
  docker logs "$scheduler" >&2 || true
  docker logs "$api" >&2 || true
  echo "API did not become healthy" >&2
  return 1
}

start_api
wait_healthy

docker run --rm --network "$network" \
  --entrypoint node "$image" \
  -e "fetch('http://$api:3000/v1/health').then(async r=>{if(!r.ok)process.exit(1);const body=await r.json();if(body.data?.status!=='ok')process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})"

docker run --rm -v "$volume:/data" \
  --entrypoint /app/apps/worker/node_modules/.bin/tsx \
  "$image" \
  -e 'import { InfoHubDatabaseReader } from "/app/packages/db/src/index.ts"; const db=new InfoHubDatabaseReader("/data/feeds.sqlite"); const sources=db.listSources(); if(!sources.some(source=>source.id==="smoke-source")) throw new Error("smoke source missing"); db.close();'

docker rm -f "$api" >/dev/null
start_api
wait_healthy

docker stop -t 5 "$scheduler" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$scheduler")" = "0"
