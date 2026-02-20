import type { ProviderCatalogEntry } from "@/lib/tauri";

export interface SelectOption {
  value: string;
  label: string;
  badge?: string;
}

// Synced with OpenRouter public models API (free + tool-capable subset):
// https://openrouter.ai/api/v1/models
const OPENROUTER_FREE_MODEL_IDS = [
  "qwen/qwen3-235b-a22b-thinking-2507",
  "openrouter/free",
  "openai/gpt-oss-120b:free",
  "openai/gpt-oss-20b:free",
  "qwen/qwen3-coder:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "google/gemma-3-27b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
] as const;

const OPENROUTER_LABEL_OVERRIDES: Record<string, string> = {
  "qwen/qwen3-235b-a22b-thinking-2507": "Qwen3 235B Thinking",
  "openrouter/free": "OpenRouter Free (Auto)",
  "openai/gpt-oss-120b:free": "GPT-OSS 120B",
  "openai/gpt-oss-20b:free": "GPT-OSS 20B",
  "qwen/qwen3-coder:free": "Qwen3 Coder",
  "qwen/qwen3-next-80b-a3b-instruct:free": "Qwen3 Next 80B Instruct",
  "meta-llama/llama-3.3-70b-instruct:free": "Llama 3.3 70B Instruct",
  "google/gemma-3-27b-it:free": "Gemma 3 27B IT",
  "mistralai/mistral-small-3.1-24b-instruct:free": "Mistral Small 3.1 24B",
};

const OPENROUTER_FREE_OPTIONS: SelectOption[] = OPENROUTER_FREE_MODEL_IDS.map(
  (id) => ({
    value: id,
    label: OPENROUTER_LABEL_OVERRIDES[id] ?? id,
    badge: "Free",
  }),
);

export const KNOWN_CHAT_MODELS: Record<string, SelectOption[]> = {
  openai: [
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-5.1", label: "GPT-5.1" },
    { value: "gpt-5", label: "GPT-5" },
    { value: "gpt-5-nano", label: "GPT-5 Nano" },
  ],
  anthropic: [
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  google: [
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { value: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
  ],
  openrouter: OPENROUTER_FREE_OPTIONS,
};

const FALLBACK_CHAT_PROVIDER_OPTIONS: SelectOption[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google Gemini" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "ollama", label: "Ollama" },
  { value: "lm_studio", label: "LM Studio" },
];

export function buildChatProviderOptions(
  providers: ProviderCatalogEntry[],
): SelectOption[] {
  if (providers.length > 0) {
    return providers.map((p) => ({ value: p.id, label: p.display_name }));
  }
  return FALLBACK_CHAT_PROVIDER_OPTIONS;
}

export function parseModelId(
  modelId: string | null | undefined,
): { provider: string; model: string } {
  const raw = modelId?.trim();
  if (!raw) {
    return { provider: "", model: "" };
  }
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator >= raw.length - 1) {
    return { provider: "", model: "" };
  }
  return {
    provider: raw.slice(0, separator).trim().toLowerCase(),
    model: raw.slice(separator + 1).trim(),
  };
}

export function formatModelId(
  provider: string,
  model: string,
): string | null {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim();
  if (!normalizedProvider || !normalizedModel) {
    return null;
  }

  const separator = normalizedModel.indexOf(":");
  if (separator > 0 && separator < normalizedModel.length - 1) {
    const embeddedProvider = normalizedModel.slice(0, separator).trim().toLowerCase();
    if (embeddedProvider === normalizedProvider) {
      return normalizedModel;
    }
  }

  return `${normalizedProvider}:${normalizedModel}`;
}
