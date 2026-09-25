#!/bin/sh
set -eu

config="${NJU_INFO_CONFIG:-/app/instances/official.json}"
source_dir="${NJU_INFO_SOURCE_DIR:-/app/sources/nju}"
database="${NJU_INFO_DB:-/data/feeds.sqlite}"
output_dir="${NJU_INFO_OUTPUT:-/output}"
host="${NJU_INFO_HOST:-0.0.0.0}"
port="${NJU_INFO_PORT:-3000}"

instance_tsx="/app/packages/instance-config/node_modules/.bin/tsx"
instance_cli="/app/packages/instance-config/src/cli.ts"
api_tsx="/app/apps/api/node_modules/.bin/tsx"
api_cli="/app/apps/api/src/cli.ts"
worker_tsx="/app/apps/worker/node_modules/.bin/tsx"
worker_cli="/app/apps/worker/src/cli.ts"

command="${1:-serve}"
if [ "$#" -gt 0 ]; then shift; fi

case "$command" in
  serve|api)
    exec "$api_tsx" "$api_cli" "$database" --host "$host" --port "$port" "$@"
    ;;
  validate)
    exec "$instance_tsx" "$instance_cli" validate "$config" "$source_dir" "$@"
    ;;
  collect)
    exec "$instance_tsx" "$instance_cli" collect "$config" "$source_dir" "$database" "$@"
    ;;
  export)
    mkdir -p "$output_dir"
    exec "$instance_tsx" "$instance_cli" export "$config" "$source_dir" "$database" "$output_dir" "$@"
    ;;
  worker)
    exec "$worker_tsx" "$worker_cli" "$@"
    ;;
  *)
    echo "usage: nju-info [serve|validate|collect|export|worker]" >&2
    exit 64
    ;;
esac
