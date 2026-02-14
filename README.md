# meld

Superpersonalized AI that shares a knowledge base with you. Local-first, open source.

Point meld at your folder of markdown notes — it reads them, answers questions with source citations, and creates new notes on its own. Every AI change is auto-committed to git so you can always roll back.

## Why meld

Most AI forgets you after every chat. meld is different — you and AI share the same files. Both read, write, and build on the same knowledge base. The more you use it, the smarter it gets.

- **Works with what you have** — Obsidian vaults, Logseq graphs, or any folder of `.md` files
- **Answers from your notes** — ask a question, get an answer with clickable citations back to your files
- **Creates and edits notes** — an autonomous agent that researches, writes, and links notes for you
- **Searches the web** — optional Tavily integration to ground answers with live data
- **Nothing leaves your machine** — all data stays local, no cloud sync, no telemetry
- **Git safety net** — every change is auto-committed; undo anything from the UI
- **Bring your own key** — OpenAI, Anthropic, or Google — pick your provider
- **Tiny footprint** — cross-platform desktop app under 15 MB (Linux, macOS, Windows)

## Install

Download the latest release for your platform:

**[GitHub Releases](https://github.com/kizz-tech/meld/releases)**

| Platform | Format |
|----------|--------|
| Linux | `.AppImage`, `.deb` |
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Windows | `.msi`, `.exe` |

## Quick Start

1. Download and install meld
2. Open it and point to your markdown folder (or create a new one)
3. Add an API key in Settings (OpenAI, Anthropic, or Google)
4. Start chatting — meld indexes your notes automatically

## Privacy

- API keys are stored locally in `~/.meld/config.toml` and never leave your device (except to call your chosen AI provider)
- Your notes stay on your machine — no cloud, no sync, no tracking
- Every vault change is git-committed for full history and safe rollback
- Open source (AGPL-3.0) — audit the code yourself

---

## Development

Want to contribute or build from source?

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (v22+)
- [pnpm](https://pnpm.io/)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS

### Build & Run

```bash
pnpm install        # Install frontend dependencies
cargo tauri dev     # Run in development mode with hot reload
cargo tauri build   # Build production binary
```

### Test

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests
cargo clippy --manifest-path src-tauri/Cargo.toml  # Lint
pnpm lint                                          # ESLint
pnpm typecheck                                     # TypeScript
```

## Architecture

Tauri 2.0 desktop app — Rust backend with a Next.js frontend. Three-layer architecture: Core (agent loop, state machine) → Adapters (LLM providers, tools, storage) → Runtime (IPC commands).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for PR process and code style.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[AGPL-3.0](LICENSE)
