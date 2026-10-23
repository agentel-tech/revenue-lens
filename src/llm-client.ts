// OpenAI-compatible chat client. One code path for every provider:
//   NVIDIA hosted Nemotron: LLM_BASE_URL=https://integrate.api.nvidia.com/v1
//   Meterless Runtime:      LLM_BASE_URL=http://127.0.0.1:8088/v1, LLM_MODEL=meterless/auto
// Switching provider is configuration only. No SDK dependency: plain fetch.

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: "meterless" | "openai-compatible";
  timeoutMs: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  model: string;
  provider: LLMConfig["provider"];
  baseUrl: string;
  elapsedMs: number;
}

export const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const APP_ID = "revenue-lens";

// Accept a pasted URL with or without a scheme, /v1, /v1/chat/completions,
// /v1/models or /healthz, and normalise it to <origin>/v1. Never /v1/v1.
export function normalizeBaseUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  let pathname = parsed.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/(chat\/completions|models|healthz)$/, "");
  pathname = pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/v1")) pathname = `${pathname}/v1`;
  return `${parsed.origin}${pathname}`;
}

export function loadLLMConfig(env: NodeJS.ProcessEnv = process.env): LLMConfig | null {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = normalizeBaseUrl(env.LLM_BASE_URL || DEFAULT_BASE_URL);
  const model = env.LLM_MODEL?.trim() || DEFAULT_MODEL;
  const provider = model.startsWith("meterless/") || env.LLM_PROVIDER === "meterless" ? "meterless" : "openai-compatible";
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) || 180_000; // a model load can take minutes
  return { baseUrl, apiKey, model, provider, timeoutMs };
}

function headers(config: LLMConfig, chat: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.provider === "meterless") {
    h["meterless-app"] = APP_ID;
    if (chat) h["meterless-scope"] = "user";
  }
  return h;
}

export async function chat(config: LLMConfig, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<ChatResult> {
  const started = Date.now();
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(config, true),
    signal: AbortSignal.timeout(config.timeoutMs),
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.2,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`LLM ${res.status} from ${config.baseUrl} (${config.model}): ${detail}`);
  }
  const data = (await res.json()) as { model?: string; choices?: { message?: { content?: string | null } }[] };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error(`LLM returned an empty response (${config.model})`);
  return { text, model: data.model ?? config.model, provider: config.provider, baseUrl: config.baseUrl, elapsedMs: Date.now() - started };
}

// GET /models decides reachability: 401/403 is "unauthorized", 200 is "online",
// anything else (including a network error) is "offline".
export async function probe(config: LLMConfig): Promise<"online" | "unauthorized" | "offline"> {
  try {
    const res = await fetch(`${config.baseUrl}/models`, { headers: headers(config, false), signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return res.ok ? "online" : "offline";
  } catch {
    return "offline";
  }
}
