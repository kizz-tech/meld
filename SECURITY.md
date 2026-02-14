# Security Policy

## Reporting Vulnerabilities

Please report security vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/kizz-tech/meld/security/advisories/new).

Do not open public issues for security vulnerabilities.

## Security Model

- **API keys** are stored locally in `~/.meld/config.toml` and never leave the device except to call the chosen LLM provider
- **Vault data** stays on your machine — no cloud sync, no telemetry, no analytics
- **Git safety** — every vault write is auto-committed; any change can be reverted from the UI
- **No remote code execution** — the agent can only use registered MCP tools (kb_search, kb_read, kb_create, kb_update, kb_list, web_search)

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x | Yes |
