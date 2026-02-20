import type { Config } from "@/lib/tauri";

const LEGACY_PROVIDER_KEY_FIELDS: Partial<Record<string, keyof Config>> = {
  openai: "openai_api_key",
  anthropic: "anthropic_api_key",
  google: "google_api_key",
};

const EMBEDDING_PROVIDER_PRIORITY = ["google", "openai"];

export const DEFAULT_EMBEDDING_MODELS: Record<string, string> = {
  openai: "text-embedding-3-small",
  google: "gemini-embedding-001",
};

function uniqueLower(values: string[]): string[] {
  const unique: string[] = [];
  for (const raw of values) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized || unique.includes(normalized)) continue;
    unique.push(normalized);
  }
  return unique;
}

export function providerHasCredential(config: Config, provider: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider) return false;

  if (config.auth_modes?.[normalizedProvider] === "oauth") {
    const oauthTokens = config.oauth_tokens as Record<string, unknown> | undefined;
    return Boolean(oauthTokens?.[normalizedProvider]);
  }

  const keyFromMap = config.api_keys?.[normalizedProvider];
  const legacyField = LEGACY_PROVIDER_KEY_FIELDS[normalizedProvider];
  const legacyValue =
    legacyField && typeof config[legacyField] === "string"
      ? config[legacyField]
      : null;
  const resolved = keyFromMap ?? legacyValue;
  return typeof resolved === "string" && resolved.trim().length > 0;
}

export function resolveEmbeddingProviderForIndexing(config: Config): string | null {
  const currentEmbeddingProvider = (
    config.embedding_provider?.trim().toLowerCase() || "openai"
  );
  const candidates = uniqueLower([
    currentEmbeddingProvider,
    ...EMBEDDING_PROVIDER_PRIORITY,
  ]);
  return (
    candidates.find(
      (provider) =>
        Boolean(DEFAULT_EMBEDDING_MODELS[provider]) &&
        providerHasCredential(config, provider),
    ) ?? null
  );
}

