#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  state-rclone.sh restore <remote-file> <local-snapshot>
  state-rclone.sh upload <local-snapshot> <remote-file>
EOF
}

command_name="${1:-}"
source_path="${2:-}"
destination_path="${3:-}"
if [[ -z "$command_name" || -z "$source_path" || -z "$destination_path" || "$#" -ne 3 ]]; then
  usage
  exit 2
fi

case "$command_name" in
  restore)
    mkdir -p "$(dirname "$destination_path")"
    temporary="${destination_path}.download-$$"
    trap 'rm -f "$temporary"' EXIT INT TERM
    if ! rclone copyto "$source_path" "$temporary"; then
      echo "durable state snapshot is unavailable; cache fallback may be used" >&2
      exit 3
    fi
    mv -f "$temporary" "$destination_path"
    trap - EXIT INT TERM
    ;;

  upload)
    if [[ ! -f "$source_path" ]]; then
      echo "state snapshot does not exist: $source_path" >&2
      exit 1
    fi
    upload_id="${NJU_INFO_STATE_UPLOAD_ID:-local-$$}"
    temporary_remote="${destination_path}.tmp-${upload_id}"
    verification_copy="$(mktemp)"
    cleanup() {
      rm -f "$verification_copy"
      rclone deletefile "$temporary_remote" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT INT TERM

    rclone copyto "$source_path" "$temporary_remote"
    rclone copyto "$temporary_remote" "$verification_copy"
    if ! cmp -s "$source_path" "$verification_copy"; then
      echo "uploaded durable state snapshot failed byte-for-byte verification" >&2
      exit 1
    fi
    rclone moveto "$temporary_remote" "$destination_path"

    rm -f "$verification_copy"
    trap - EXIT INT TERM
    ;;

  *)
    usage
    exit 2
    ;;
esac
