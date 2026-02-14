#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_PATH="$ROOT_DIR/docs/KB_SYNC_LOG.md"

required_header='| date | kb_repo_commit | code_repo_commit | scope | status | score_before | score_after | gaps_remaining | owner | next_sync_due |'

if [[ ! -f "$LOG_PATH" ]]; then
  echo "Missing $LOG_PATH"
  exit 1
fi

if ! grep -Fq "$required_header" "$LOG_PATH"; then
  echo "KB_SYNC_LOG header is missing required columns."
  echo "Expected:"
  echo "$required_header"
  exit 1
fi

last_row=$(grep '^|' "$LOG_PATH" | tail -n 1)
if [[ -z "$last_row" ]]; then
  echo "KB_SYNC_LOG has no entries."
  exit 1
fi

# Fields are pipe-delimited: empty at start/end, so next_sync_due is field 11.
next_sync_due=$(echo "$last_row" | awk -F'|' '{gsub(/^ +| +$/, "", $11); print $11}')
if [[ -z "$next_sync_due" || "$next_sync_due" == "next_sync_due" ]]; then
  echo "Could not parse next_sync_due from latest KB_SYNC_LOG row."
  exit 1
fi

if [[ ! "$next_sync_due" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "Invalid next_sync_due format: '$next_sync_due' (expected YYYY-MM-DD)."
  exit 1
fi

today=$(date +%F)
if [[ "$today" > "$next_sync_due" ]]; then
  echo "KB sync overdue: today=$today next_sync_due=$next_sync_due"
  exit 1
fi

echo "KB sync log is valid and in SLA. today=$today next_sync_due=$next_sync_due"
