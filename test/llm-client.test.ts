import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, loadLLMConfig, normalizeBaseUrl } from "../src/llm-client.ts";

test("normalizeBaseUrl accepts pasted variants and never doubles /v1", () => {
  const want = "http://127.0.0.1:8088/v1";
  for (const input of [
    "127.0.0.1:8088",
    "http://127.0.0.1:8088",
    "http://127.0.0.1:8088/",
    "http://127.0.0.1:8088/v1",
    "http://127.0.0.1:8088/v1/",
    "http://127.0.0.1:8088/v1/chat/completions",
    "http://127.0.0.1:8088/v1/models",
    "http://127.0.0.1:8088/healthz",
  ]) {
    assert.equal(normalizeBaseUrl(input), want, input);
  }
  assert.equal(normalizeBaseUrl("https://integrate.api.nvidia.com/v1"), "https://integrate.api.nvidia.com/v1");
});

test("no key means retrieval-only (null config)", () => {
  assert.equal(loadLLMConfig({}), null);
  assert.equal(loadLLMConfig({ LLM_API_KEY: "  " }), null);
});

test("defaults to NVIDIA Nemotron; meterless/* models switch provider", () => {
  const nv = loadLLMConfig({ LLM_API_KEY: "k" })!;
  assert.equal(nv.baseUrl, DEFAULT_BASE_URL);
  assert.equal(nv.model, DEFAULT_MODEL);
  assert.equal(nv.provider, "openai-compatible");
  const ml = loadLLMConfig({ LLM_API_KEY: "k", LLM_BASE_URL: "127.0.0.1:8088", LLM_MODEL: "meterless/auto" })!;
  assert.equal(ml.provider, "meterless");
  assert.equal(ml.baseUrl, "http://127.0.0.1:8088/v1");
});
