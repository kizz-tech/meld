#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATASET_PATH="$ROOT_DIR/src-tauri/tests/retrieval_eval/dataset.yaml"

if [[ ! -f "$DATASET_PATH" ]]; then
  echo "Missing retrieval eval dataset: $DATASET_PATH"
  exit 1
fi

echo "Running retrieval eval harness tests..."
cargo test --manifest-path "$ROOT_DIR/src-tauri/Cargo.toml" rag::eval::tests -- --nocapture
