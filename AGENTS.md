# AGENTS.md

You are working on the **meld** codebase — a local-first AI agent for markdown knowledge bases. It indexes folders of markdown notes (Obsidian, Logseq, plain `.md`), answers questions with source attribution, and autonomously creates/edits notes. Every AI write is git-committed for safe rollback.

- **Stack**: Tauri 2.0 desktop app — Rust backend + Next.js frontend
- **License**: AGPL-3.0-or-later
- **Repo**: `github.com/kizz-tech/meld`

## Architecture

Three layers with strict dependency direction: **Core → Adapters → Runtime**.

| Layer | Path | Responsibility |
|-------|------|----------------|
| Core | `src-tauri/src/core/` | Agent loop, ports (traits), state machine, budget, instructions, events |
| Adapters | `src-tauri/src/adapters/` | LLM providers, tools, storage, git, config, embeddings, RAG, OAuth |
| Runtime | `src-tauri/src/runtime/` | Tauri IPC commands, app initialization, event wiring |

**Dependency rules**:
- Core depends on nothing outside `std` and its own port traits
- Adapters implement port traits; may use external crates
- Runtime wires adapters into core; exposes IPC commands to the frontend

### Backend (`src-tauri/src/`)

**Core** (`core/`) — pure domain logic, no external dependencies beyond `std`.
- `core/agent/` — Agent struct, state machine, main loop, budget enforcement, system prompt composition, post-write verification, context compaction, event ledger
- `core/ports/` — Trait definitions (`LlmPort`, `ToolPort`, `StorePort`, `EmitterPort`) that adapters implement

**Adapters** (`adapters/`) — implement port traits using external crates.
- `adapters/llm/` — Chat streaming, retry/fallback. Provider implementations in `providers/` (OpenAI, Anthropic, Google)
- `adapters/mcp/` — MCP tool registry and executors (kb_search, kb_read, kb_create, kb_update, kb_list, web_search)
- `adapters/rag/` — Semantic chunking, hybrid search (BM25 + vector), re-ranking, eval
- `adapters/vectordb/` — SQLite-backed vector DB, conversation/message/run storage
- `adapters/vault/` — Vault initialization (`.meld/` directory), file scanning
- `adapters/git/` — Auto-commit on every write, revert, history
- `adapters/embeddings/` — Embedding generation (OpenAI, Google)
- `adapters/markdown/` — Markdown parsing, frontmatter extraction
- `adapters/config/` — Settings persistence (TOML), API key management
- `adapters/providers/` — Provider catalog, model resolution, fallback chains
- `adapters/oauth/` — OAuth2 authorization flows
- `adapters/emitter.rs` — Bridges `EmitterPort` to Tauri events

**Runtime** (`runtime/`) — wires everything together, exposes IPC.
- `runtime/tauri_api/commands/` — Tauri IPC command handlers (vault, assistant, conversations, settings, history, watcher)

### Frontend (`src/`)

- `src/app/` — Next.js pages and layout
- `src/components/chat/` — Chat interface: message list, bubbles, input, agent activity indicator
- `src/components/sidebar/` — Conversation list, folders, search, drag-and-drop
- `src/components/vault/` — Vault file browser, note preview, drag-and-drop
- `src/components/settings/` — Provider, model, API key configuration
- `src/components/history/` — Git history timeline, revert UI
- `src/components/ui/` — Shared UI primitives (dialogs, status bar, run trace)
- `src/features/layout/` — Main orchestration hook (`useHomeController`) and helpers
- `src/lib/store.ts` — Zustand single store (~40 state props)
- `src/lib/events.ts` — Tauri event listeners (chat:chunk, agent:run_state, etc.)
- `src/lib/tauri.ts` — Typed IPC command wrappers
- `src/state/` — Zustand selectors

## Core Ports

Four trait-based abstractions in `core/ports/` — all `Send + Sync`, held as `Arc<dyn Port>`:

| Port | Purpose |
|------|---------|
| **LlmPort** | Stream chat completions from any provider |
| **ToolPort** | Register tool definitions, execute tool calls |
| **StorePort** | Persist run events (start, log, finish) |
| **EmitterPort** | Emit events to frontend via Tauri |

## Agent State Machine

```
Accepted → Planning → Thinking → ToolCalling → Verifying → Responding → Completed
                                      ↑              |
                                      └──────────────┘  (loop until no tool calls or budget exceeded)
```

Additional terminal states: `Failed`, `Timeout`, `Cancelled`.

Loop:
1. Validate index readiness
2. Check budget (time, iterations, tool calls, tokens)
3. Stream LLM response (Planning/Thinking phase)
4. Collect tool calls; if none → Responding → Completed
5. Execute tools (ToolCalling)
6. Verify write operations (Verifying) — readback check
7. Append results to messages, loop to step 2

Budget defaults: 15 iterations, 30 tool calls, 120s wall time, 45s per LLM response.

## Key Patterns

### Provider Registry

Model IDs follow `"provider:model"` format (e.g., `"anthropic:claude-opus-4-6"`). The registry in `adapters/providers/` resolves provider + credentials at call time. New providers implement `LlmProvider` and/or `EmbeddingProvider` traits.

### MCP Tools

Tools implement `ToolExecutor` trait in `adapters/mcp/`. Each declares a JSON Schema for parameters. The agent receives tool definitions in the LLM request and calls them by name. Tool context carries vault path, DB path, and API keys.

### Git Safety

Every vault write (kb_create, kb_update) triggers an auto-commit via `adapters/git/`. The frontend can list history and revert any commit. Never claim a write succeeded without a readback verification check.

### Streaming Events

Backend emits events through `EmitterPort` → Tauri event system → frontend listeners in `src/lib/events.ts`. Key channels: `chat:chunk`, `chat:done`, `agent:run_state`, `agent:tool_call`, `agent:tool_result`, `agent:timeline_step`, `index:progress`.

### Budget System

`core/agent/` enforces wall-time, iteration, tool-call, and token limits. The agent loop checks budget before each iteration. Exceeding any limit transitions to `Timeout`.

### Instruction Sources

System prompt is composed from layers:
1. Built-in identity and safety rules
2. `AGENTS.md` from vault root (if exists)
3. `.meld/rules` — must-follow directives
4. `.meld/hints` — guidance and tips
5. MCP tool listing
6. Runtime context (date, vault path, note count, language, provider/model)

## Build & Test

All commands go through pnpm. Tauri CLI is a dev dependency — no global install needed.

```bash
pnpm install        # Install all deps (JS + fetches Rust crates)
pnpm dev            # Dev mode (Next.js + Tauri window)
pnpm build          # Production build
pnpm check          # Run ALL checks (fmt + lint + clippy + test + typecheck)
pnpm test           # Rust tests only
pnpm lint           # ESLint only
pnpm lint:rust      # Clippy only
pnpm lint:all       # ESLint + Clippy
pnpm fmt            # Auto-format Rust code
pnpm fmt:check      # Check Rust formatting
pnpm typecheck      # TypeScript type check
```

## Conventions

- Commit messages: [Conventional Commits](https://www.conventionalcommits.org/) — `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`, `perf`, `ci`, `build`
- Rust: `snake_case.rs` for modules, `PascalCase` for types/traits
- TypeScript: `PascalCase.tsx` for components, `camelCase.ts` for utilities
- One component per file in `src/components/`

## Constraints

- Never call adapter code directly from core — use port traits
- Write tools must verify via readback before reporting success
- Use the provider registry pattern — never hardcode provider logic
- No sync I/O in async paths — all I/O goes through tokio
- API keys live in user config only — never in code or git
- Changing event channel names or payload shapes requires updating `src/lib/events.ts`
- Keep the binary small (< 15 MB target) — justify new dependencies
