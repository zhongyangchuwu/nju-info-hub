#!/bin/sh
set -eu

exec /app/apps/nju-info/node_modules/.bin/tsx /app/apps/nju-info/src/cli.ts "$@"
