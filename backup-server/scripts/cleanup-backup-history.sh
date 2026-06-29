#!/usr/bin/env bash

set -euo pipefail

KEEP_COUNT=10
DRY_RUN=0
STORAGE_ROOT="${BACKUP_STORAGE_ROOT:-}"

usage() {
  cat <<'EOF'
Usage: cleanup-backup-history.sh [options] [storage_root]

Delete old backup history files per user and keep only the newest copies.

Options:
  --keep N       Keep N newest history backups per user (default: 10)
  --dry-run      Print what would be deleted without deleting anything
  -h, --help     Show this help message

Arguments:
  storage_root   Optional backup storage root. If omitted, BACKUP_STORAGE_ROOT
                 environment variable is used.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      [[ $# -ge 2 ]] || {
        echo "--keep requires a numeric value." >&2
        exit 1
      }
      KEEP_COUNT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$STORAGE_ROOT" ]]; then
        echo "Only one storage_root argument is allowed." >&2
        exit 1
      fi
      STORAGE_ROOT="$1"
      shift
      ;;
  esac
done

if ! [[ "$KEEP_COUNT" =~ ^[0-9]+$ ]] || [[ "$KEEP_COUNT" -lt 1 ]]; then
  echo "--keep must be a positive integer." >&2
  exit 1
fi

if [[ -z "$STORAGE_ROOT" ]]; then
  echo "Backup storage root is required. Pass it as an argument or set BACKUP_STORAGE_ROOT." >&2
  exit 1
fi

if [[ ! -d "$STORAGE_ROOT" ]]; then
  echo "Storage root does not exist or is not a directory: $STORAGE_ROOT" >&2
  exit 1
fi

if stat --version >/dev/null 2>&1; then
  STAT_KIND="gnu"
else
  STAT_KIND="bsd"
fi

get_mtime() {
  local file_path="$1"
  if [[ "$STAT_KIND" == "gnu" ]]; then
    stat -c '%Y' "$file_path"
  else
    stat -f '%m' "$file_path"
  fi
}

prune_user_history() {
  local user_dir="$1"
  local history_dir="$user_dir/history"

  if [[ ! -d "$history_dir" ]]; then
    return 0
  fi

  local records=()
  local history_file
  while IFS= read -r -d '' history_file; do
    local mtime
    mtime="$(get_mtime "$history_file")"
    records+=("${mtime}"$'\t'"${history_file}")
  done < <(find "$history_dir" -mindepth 1 -maxdepth 1 -type f -name '*.tar.gz' -print0)

  if [[ "${#records[@]}" -le "$KEEP_COUNT" ]]; then
    return 0
  fi

  local sorted_files=()
  local sorted_file
  while IFS= read -r sorted_file; do
    sorted_files+=("$sorted_file")
  done < <(
    printf '%s\n' "${records[@]}" \
      | sort -nr -k1,1 \
      | cut -f2-
  )

  local remove_count=$(( ${#sorted_files[@]} - KEEP_COUNT ))
  echo "[$(basename "$user_dir")] pruning ${remove_count} old backups from ${history_dir}"

  local i
  for ((i=KEEP_COUNT; i<${#sorted_files[@]}; i++)); do
    local target="${sorted_files[$i]}"
    case "$target" in
      "$history_dir"/*) ;;
      *)
        echo "Skipping unsafe path: $target" >&2
        continue
        ;;
    esac

    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "DRY-RUN rm -f -- $target"
    else
      rm -f -- "$target"
    fi
  done
}

while IFS= read -r -d '' user_dir; do
  prune_user_history "$user_dir"
done < <(find "$STORAGE_ROOT" -mindepth 1 -maxdepth 1 -type d -print0)
