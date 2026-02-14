#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_PATH="$ROOT_DIR/docs/KB_COMPLIANCE_REPORT.md"

# weight, label, command
CHECKS=$(cat <<'CHECKS'
10|Runtime: policy fingerprint persisted|rg -q "policy_fingerprint" "$ROOT_DIR/src-tauri/src/agent" "$ROOT_DIR/src-tauri/src/vectordb/mod.rs"
10|Runtime: index readiness gate|rg -q "index_not_ready" "$ROOT_DIR/src-tauri/src/agent/mod.rs"
7|Retrieval: heading-aware chunking|rg -q "heading_path" "$ROOT_DIR/src-tauri/src/markdown/mod.rs"
8|Retrieval: hybrid search + RRF|rg -q "search_hybrid|rrf_score" "$ROOT_DIR/src-tauri/src/vectordb/mod.rs"
7|Retrieval: HyDE generation|rg -q "generate_hyde_document" "$ROOT_DIR/src-tauri/src/rag/mod.rs"
8|Retrieval: rerank stage|rg -q "mod rerank|rerank::rerank" "$ROOT_DIR/src-tauri/src/rag/mod.rs"
15|Provider: registry + provider:model|rg -q "ProviderRegistry|split_model_id" "$ROOT_DIR/src-tauri/src/providers/mod.rs"
10|Provider: catalog command|rg -q "get_provider_catalog" "$ROOT_DIR/src-tauri/src/commands.rs"
5|Eval: dataset exists|test -f "$ROOT_DIR/src-tauri/tests/retrieval_eval/dataset.yaml"
5|Eval: metrics module exists|rg -q "RetrievalEvalReport|evaluate_predictions" "$ROOT_DIR/src-tauri/src/rag/eval.rs"
8|OAuth pass-through: auth mode scaffolding|rg -q "set_auth_mode|auth_modes" "$ROOT_DIR/src-tauri/src/commands.rs" "$ROOT_DIR/src-tauri/src/config/mod.rs" "$ROOT_DIR/src/lib/tauri.ts"
7|OAuth pass-through: end-to-end flow|rg -q "tauri-plugin-oauth|start_oauth|finish_oauth|disconnect_oauth" "$ROOT_DIR/src-tauri/src" "$ROOT_DIR/src/lib/tauri.ts"
CHECKS
)

total_weight=0
score=0
rows=()

while IFS='|' read -r weight label cmd; do
  [[ -z "${weight}" ]] && continue
  total_weight=$((total_weight + weight))
  if eval "$cmd" >/dev/null 2>&1; then
    score=$((score + weight))
    status="implemented"
  else
    status="missing"
  fi
  rows+=("| ${label} | ${weight} | ${status} |")
done <<< "$CHECKS"

percent=0
if [[ "$total_weight" -gt 0 ]]; then
  percent=$(( (score * 100) / total_weight ))
fi

cat > "$REPORT_PATH" <<REPORT
# KB Compliance Report

Generated: $(date -Iseconds)

## Score

- **${score}/${total_weight} (${percent}%)**

## Checks

| Check | Weight | Status |
|---|---:|---|
$(printf "%s\n" "${rows[@]}")

## Notes

- This report is a lightweight static audit and does not replace functional QA.
- For schedule enforcement run: scripts/kb_sync_check.sh.
REPORT

echo "KB audit complete: ${score}/${total_weight} (${percent}%)."
echo "Report: ${REPORT_PATH}"
