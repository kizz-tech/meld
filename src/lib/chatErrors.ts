import type { ToastOptions } from "@/lib/store";

export interface ChatErrorToast {
  message: string;
  options?: ToastOptions;
}

function extractMessageFromObject(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const fields = ["message", "error", "reason", "details"];

  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  const payload = record.payload;
  if (payload && typeof payload === "object") {
    const nested = payload as Record<string, unknown>;
    for (const field of fields) {
      const value = nested[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  return null;
}

function normalizeErrorMessage(raw: unknown): string {
  const text = raw instanceof Error
    ? raw.message
    : typeof raw === "string"
      ? raw
      : extractMessageFromObject(raw) ?? String(raw);

  return text
    .replace(/^Error:\s*/i, "")
    .replace(/^Error invoking `[^`]+`:\s*/i, "")
    .trim();
}

function extractMissingProvider(message: string): string | null {
  const providerMatch = message.match(/provider ['"]?([^'".\s]+)['"]?/i);
  const provider = providerMatch?.[1]?.trim();
  return provider && provider.length > 0 ? provider : null;
}

export function buildChatErrorToast(raw: unknown): ChatErrorToast {
  const message = normalizeErrorMessage(raw);
  const lower = message.toLowerCase();

  if (
    lower.includes("no endpoints found that support tool use")
    || lower.includes("does not support tool use on openrouter")
  ) {
    return {
      message:
        "Selected OpenRouter model cannot use tools. In Settings -> Chat switch to qwen/qwen3-235b-a22b-thinking-2507 or openrouter/free, then retry.",
      options: { action: "open_settings", durationMs: 9000 },
    };
  }

  if (
    lower.includes("no endpoints found matching your data policy")
    || lower.includes("free model publication")
  ) {
    return {
      message:
        "OpenRouter blocked this free model by your privacy policy. In OpenRouter Settings -> Privacy enable Free model publication, or switch to another model.",
      options: { durationMs: 9000 },
    };
  }

  if (lower.includes("no api key configured for provider")) {
    const provider = extractMissingProvider(message);
    return {
      message: provider
        ? `Cannot send message: ${provider} key is missing. Add key in Settings or switch to OAuth.`
        : "Cannot send message: API key is missing. Add key in Settings or switch to OAuth.",
      options: { action: "open_settings", durationMs: 9000 },
    };
  }

  if (lower.includes("oauth")) {
    return {
      message: `Chat failed: ${message}`,
      options: { action: "open_settings", durationMs: 9000 },
    };
  }

  return { message: `Chat failed: ${message}` };
}

export function buildReindexErrorToast(raw: unknown): ChatErrorToast {
  const message = normalizeErrorMessage(raw);
  const lower = message.toLowerCase();

  if (
    lower.includes("no api key configured for provider")
    || lower.includes("no embedding credentials configured for reindex")
    || lower.includes("background indexing is disabled")
  ) {
    const provider = extractMissingProvider(message);
    return {
      message: provider
        ? `Reindex unavailable: ${provider} key is missing. Add key in Settings or switch to OAuth.`
        : "Reindex unavailable: OpenAI or Google key is missing. Add key in Settings or switch to OAuth.",
      options: { action: "open_settings", durationMs: 9000 },
    };
  }

  if (lower.includes("oauth")) {
    return {
      message: `Reindex failed: ${message}`,
      options: { action: "open_settings", durationMs: 9000 },
    };
  }

  return { message: `Reindex failed: ${message}` };
}

export function buildIndexingDisabledToast(): ChatErrorToast {
  return {
    message:
      "Background indexing is disabled. Add OpenAI or Google key in Settings.",
    options: { action: "open_settings", durationMs: 9000 },
  };
}
