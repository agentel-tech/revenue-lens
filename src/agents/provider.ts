// Provider adapter owned by agents/. Does not modify shared llm-client.ts.
// NVIDIA official host: native fetch with thinking disabled + json_object.
// Other providers: existing chat() path (providerResponseId always null).

import {
  chat,
  loadLLMConfig,
  type ChatMessage,
  type LLMConfig,
} from "../llm-client.ts";
import type { ChatTurn, ModelCaller, ModelResponse } from "./types.ts";

export const NVIDIA_OFFICIAL_HOST = "integrate.api.nvidia.com";

/** Soft ceiling on assistant content length (chars); oversize fails closed. */
export const MAX_ASSISTANT_CONTENT_CHARS = 48_000;

/** Cap wait even if LLM_TIMEOUT_MS is huge. */
export const PROVIDER_TIMEOUT_CAP_MS = 180_000;

/** Checker-only NVIDIA thinking when LLM_CHECKER_THINKING=true (default off). */
export const CHECKER_THINKING_MAX_TOKENS = 8192;
export const CHECKER_THINKING_REASONING_BUDGET = 4096;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function isNvidiaOfficialHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === NVIDIA_OFFICIAL_HOST;
  } catch {
    return false;
  }
}

export function investigatorMaxTokens(): number {
  return 4096;
}

export function checkerMaxTokens(): number {
  return 2048;
}

/** Opt-in checker-only reasoning for NVIDIA official host. Never enabled by default. */
export function isCheckerThinkingEnabled(): boolean {
  return process.env.LLM_CHECKER_THINKING === "true";
}

function boundedTimeoutMs(config: LLMConfig): number {
  const n = Number(config.timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return PROVIDER_TIMEOUT_CAP_MS;
  return Math.min(n, PROVIDER_TIMEOUT_CAP_MS);
}

function providerError(status: number): Error {
  // Never include raw provider error bodies or secrets.
  return new Error(`LLM request failed with status ${status}`);
}

function contentFromChoice(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  // Content only — never collect reasoning / thinking fields.
  const content = message.content;
  if (typeof content === "string") return content;
  if (content == null) return "";
  return "";
}

function providerResponseIdFrom(data: Record<string, unknown>): string | null {
  const id = data.id;
  if (typeof id === "string" && id.trim()) return id.trim();
  return null;
}

/** Build the NVIDIA chat/completions JSON body (for tests + live). */
export function buildNvidiaChatBody(opts: {
  model: string;
  messages: ChatMessage[];
  role: "investigator" | "checker";
  temperature?: number;
  /** Override env for tests; defaults to LLM_CHECKER_THINKING===\"true\". */
  checkerThinking?: boolean;
}): Record<string, unknown> {
  const thinking =
    opts.role === "checker" && (opts.checkerThinking ?? isCheckerThinkingEnabled());
  const maxTokens = thinking
    ? CHECKER_THINKING_MAX_TOKENS
    : opts.role === "checker"
      ? checkerMaxTokens()
      : investigatorMaxTokens();
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: maxTokens,
    temperature: opts.temperature ?? 0.2,
    response_format: { type: "json_object" },
    chat_template_kwargs: { enable_thinking: thinking },
  };
  if (thinking) {
    body.reasoning_budget = CHECKER_THINKING_REASONING_BUDGET;
  }
  return body;
}

export async function nvidiaChatCompletions(
  config: LLMConfig,
  messages: ChatMessage[],
  opts: { role: "investigator" | "checker"; temperature?: number },
  fetchImpl: FetchLike = fetch,
): Promise<ModelResponse> {
  const body = buildNvidiaChatBody({
    model: config.model,
    messages,
    role: opts.role,
    temperature: opts.temperature,
  });

  let res: Response;
  try {
    res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: AbortSignal.timeout(boundedTimeoutMs(config)),
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("LLM request failed (network or timeout)");
  }

  if (!res.ok) {
    // Drain body without retaining/logging it.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    throw providerError(res.status);
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error("LLM returned malformed JSON envelope");
  }

  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("LLM response missing choices");
  }
  const first = choices[0];
  if (!first || typeof first !== "object") {
    throw new Error("LLM response malformed choice");
  }
  const finishReason = (first as { finish_reason?: unknown }).finish_reason;
  assertSafeFinishReason(finishReason);

  const message = (first as { message?: Record<string, unknown> }).message;
  const text = contentFromChoice(message);
  if (!text.trim()) {
    throw new Error("LLM returned empty content");
  }
  if (text.length > MAX_ASSISTANT_CONTENT_CHARS) {
    throw new Error("LLM content exceeds length limit");
  }

  return {
    text,
    providerResponseId: providerResponseIdFrom(data),
    finishReason: typeof finishReason === "string" ? finishReason : null,
    model: typeof data.model === "string" && data.model ? data.model : config.model,
    provider: config.provider,
    baseUrl: config.baseUrl,
  };
}

/** Reject truncated / filtered completions before any decision parsing. */
export function assertSafeFinishReason(finishReason: unknown): void {
  if (finishReason === "length" || finishReason === "content_filter") {
    throw new Error(`LLM finish_reason rejected: ${finishReason}`);
  }
}

export async function compatibleChatAsModelResponse(
  config: LLMConfig,
  messages: ChatMessage[],
  opts: { role: "investigator" | "checker" },
): Promise<ModelResponse> {
  // Shared chat() path — no provider response id exposed today.
  const result = await chat(config, messages, {
    maxTokens: opts.role === "checker" ? checkerMaxTokens() : investigatorMaxTokens(),
    temperature: 0.2,
  });
  return {
    text: result.text,
    providerResponseId: null,
    model: result.model,
    provider: result.provider,
    baseUrl: result.baseUrl,
  };
}

export function createModelCallerFromConfig(config: LLMConfig, fetchImpl: FetchLike = fetch): ModelCaller {
  const nvidia = isNvidiaOfficialHost(config.baseUrl);
  return async (messages: ChatTurn[], opts) => {
    const chatMessages: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
    if (nvidia) {
      return nvidiaChatCompletions(config, chatMessages, { role: opts.role }, fetchImpl);
    }
    return compatibleChatAsModelResponse(config, chatMessages, { role: opts.role });
  };
}

/** Wire default caller: loadLLMConfig → NVIDIA adapter or shared chat(). */
export function createDefaultModelCaller(fetchImpl: FetchLike = fetch): ModelCaller | null {
  const config = loadLLMConfig();
  if (!config) return null;
  return createModelCallerFromConfig(config, fetchImpl);
}
