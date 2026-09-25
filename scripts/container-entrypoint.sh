#!/bin/sh
set -eu

config="${NJU_INFO_CONFIG:-/app/instances/official.json}"
source_dir="${NJU_INFO_SOURCE_DIR:-/app/sources/nju}"
database="${NJU_INFO_DB:-/data/feeds.sqlite}"
output_dir="${NJU_INFO_OUTPUT:-/output}"
host="${NJU_INFO_HOST:-0.0.0.0}"
port="${NJU_INFO_PORT:-3000}"
ready_file="${NJU_INFO_READY_FILE:-}"
ready_timeout="${NJU_INFO_READY_TIMEOUT_SECONDS:-900}"

instance_tsx="/app/packages/instance-config/node_modules/.bin/tsx"
instance_cli="/app/packages/instance-config/src/cli.ts"
api_tsx="/app/apps/api/node_modules/.bin/tsx"
api_cli="/app/apps/api/src/cli.ts"
worker_tsx="/app/apps/worker/node_modules/.bin/tsx"
worker_cli="/app/apps/worker/src/cli.ts"
mcp_tsx="/app/apps/mcp/node_modules/.bin/tsx"
mcp_cli="/app/apps/mcp/src/cli.ts"

export NJU_INFO_SOURCE_DIR="$source_dir"

command="${1:-serve}"
if [ "$#" -gt 0 ]; then shift; fi

wait_for_ready() {
  [ -z "$ready_file" ] && return 0
  elapsed=0
  while [ ! -s "$ready_file" ]; do
    if [ "$elapsed" -ge "$ready_timeout" ]; then
      echo "timed out waiting for initial collection readiness: $ready_file" >&2
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

case "$command" in
  serve|api)
    wait_for_ready
    exec "$api_tsx" "$api_cli" "$database" --host "$host" --port "$port" "$@"
    ;;
  validate)
    exec "$instance_tsx" "$instance_cli" validate "$config" "$source_dir" "$@"
    ;;
  collect)
    exec "$instance_tsx" "$instance_cli" collect "$config" "$source_dir" "$database" "$@"
    ;;
  schedule)
    exec "$instance_tsx" "$instance_cli" schedule "$config" "$source_dir" "$database" "$@"
    ;;
  export)
    mkdir -p "$output_dir"
    exec "$instance_tsx" "$instance_cli" export "$config" "$source_dir" "$database" "$output_dir" "$@"
    ;;
  worker)
    exec "$worker_tsx" "$worker_cli" "$@"
    ;;
  mcp)
    exec "$mcp_tsx" "$mcp_cli" "$database" "$@"
    ;;
  *)
    echo "usage: nju-info [serve|validate|collect|schedule|export|worker|mcp]" >&2
    exit 64
    ;;
esac
