#!/usr/bin/env bash
# Generate changelog from conventional commits between two tags (or tag..HEAD).
# Usage:
#   ./scripts/changelog.sh              # from latest tag to HEAD
#   ./scripts/changelog.sh v0.1.0       # from v0.1.0 to HEAD
#   ./scripts/changelog.sh v0.1.0 v0.2.0  # between two tags

set -euo pipefail

FROM="${1:-$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)}"
TO="${2:-HEAD}"

echo "## What's Changed"
echo ""

# Group commits by type
declare -A SECTIONS
SECTIONS=(
  ["feat"]="Features"
  ["fix"]="Bug Fixes"
  ["docs"]="Documentation"
  ["refactor"]="Refactoring"
  ["perf"]="Performance"
  ["test"]="Tests"
  ["chore"]="Chores"
  ["ci"]="CI"
  ["style"]="Style"
)

FOUND_ANY=false

for TYPE in feat fix docs refactor perf test chore ci style; do
  COMMITS=$(git log "$FROM".."$TO" --oneline --no-merges --grep="^${TYPE}" --format="- %s (%h)" 2>/dev/null || true)
  if [ -n "$COMMITS" ]; then
    FOUND_ANY=true
    echo "### ${SECTIONS[$TYPE]}"
    echo ""
    echo "$COMMITS" | sed "s/^- ${TYPE}: /- /" | sed "s/^- ${TYPE}(\([^)]*\)): /- **\1:** /"
    echo ""
  fi
done

if [ "$FOUND_ANY" = false ]; then
  git log "$FROM".."$TO" --oneline --no-merges --format="- %s (%h)"
  echo ""
fi

echo "**Full Changelog:** https://github.com/kizz-tech/meld/compare/${FROM}...${TO}"
