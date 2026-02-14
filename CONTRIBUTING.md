# Contributing to meld

## Development Setup

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (v20+)
- [pnpm](https://pnpm.io/)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS

### Getting Started

```bash
git clone https://github.com/kizz-tech/meld.git
cd meld
pnpm install
cargo tauri dev
```

## Submitting Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Run tests and linting:
   ```bash
   cargo test --manifest-path src-tauri/Cargo.toml
   cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
   pnpm lint
   ```
4. Commit using the conventional format (see below)
5. Open a PR against `main`

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add embedding cache for repeated queries
fix: prevent duplicate tool calls in agent loop
refactor: extract provider resolution into registry
docs: update architecture section in AGENTS.md
test: add retrieval recall benchmarks
chore: bump tauri to 2.6
```

## Code Style

### Rust

- Format with `rustfmt` (default config)
- No `clippy` warnings — run `cargo clippy -- -D warnings`
- Types and traits: `PascalCase`
- Modules, functions, variables: `snake_case`

### TypeScript

- ESLint with `eslint-config-next`
- Components: `PascalCase.tsx`, one component per file
- Utilities and hooks: `camelCase.ts`
- State management: single Zustand store in `src/lib/store.ts`

## Reporting Issues

- Use [GitHub Issues](https://github.com/kizz-tech/meld/issues)
- Include: OS, meld version, steps to reproduce, expected vs actual behavior
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions are licensed under [AGPL-3.0-or-later](LICENSE).
