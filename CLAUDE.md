# CLAUDE.md

Claude Code configuration for the meld codebase. Full architecture reference: [AGENTS.md](AGENTS.md).

## Model

- **Claude Opus 4.6** — primary model
- Sonnet 4.5 / Haiku 4.5 — for sub-agents

## Sub-agents

| Agent | Use for |
|-------|---------|
| Explore | Fast codebase search and navigation |
| Plan | Architecture and implementation planning |
| Bash | Shell commands, builds, tests |

## Key Files by Area

| Area | Path |
|------|------|
| Agent loop | `src-tauri/src/core/agent/run.rs` |
| State machine | `src-tauri/src/core/agent/state.rs` |
| Budget | `src-tauri/src/core/agent/budget.rs` |
| System prompt | `src-tauri/src/core/agent/instructions.rs` |
| Port traits | `src-tauri/src/core/ports/` |
| LLM streaming | `src-tauri/src/adapters/llm/mod.rs` |
| Provider registry | `src-tauri/src/adapters/providers/mod.rs` |
| OpenAI provider | `src-tauri/src/adapters/llm/providers/openai.rs` |
| Anthropic provider | `src-tauri/src/adapters/llm/providers/anthropic.rs` |
| Google provider | `src-tauri/src/adapters/llm/providers/google.rs` |
| MCP tools | `src-tauri/src/adapters/mcp/mod.rs` |
| Vector DB | `src-tauri/src/adapters/vectordb/mod.rs` |
| Git safety | `src-tauri/src/adapters/git/mod.rs` |
| Config/settings | `src-tauri/src/adapters/config/mod.rs` |
| IPC commands | `src-tauri/src/runtime/tauri_api/commands/` |
| Frontend state | `src/lib/store.ts` |
| Event listeners | `src/lib/events.ts` |
| IPC wrappers | `src/lib/tauri.ts` |
| Main controller | `src/features/layout/controllers/useHomeController.ts` |
| Chat UI | `src/components/chat/` |
| Vault browser | `src/components/vault/VaultBrowser.tsx` |
| Settings panel | `src/components/settings/SettingsPanel.tsx` |

## Git

- Never add `Co-Authored-By` trailers to commits

## Commands

```bash
pnpm install                                    # Install deps
cargo tauri dev                                 # Dev mode
cargo tauri build                               # Production build
cargo test --manifest-path src-tauri/Cargo.toml # Rust tests
pnpm lint                                       # ESLint
```
