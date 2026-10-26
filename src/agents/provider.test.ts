import { test } from "node:test";
import assert from "node:assert/strict";
import type { LLMConfig } from "../llm-client.ts";
import {
  CHECKER_THINKING_MAX_TOKENS,
  CHECKER_THINKING_REASONING_BUDGET,
  MAX_ASSISTANT_CONTENT_CHARS,
  NVIDIA_OFFICIAL_HOST,
  buildNvidiaChatBody,
  checkerMaxTokens,
  createModelCallerFromConfig,
  investigatorMaxTokens,
  isCheckerThinkingEnabled,
  isNvidiaOfficialHost,
  nvidiaChatCompletions,
  type FetchLike,
} from "./provider.ts";
import { extractJsonObject, parseInvestigatorDecision } from "./decisions.ts";

const nvidiaConfig = (): LLMConfig => ({
  baseUrl: `https://${NVIDIA_OFFICIAL_HOST}/v1`,
  apiKey: "test-key-not-a-secret-for-unit-tests",
  model: "nvidia/nemotron-3.5-lightning-30b-a3b",
  provider: "openai-compatible",
  timeoutMs: 30_000,
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("isNvidiaOfficialHost matches integrate.api.nvidia.com only", () => {
  assert.equal(isNvidiaOfficialHost(`https://${NVIDIA_OFFICIAL_HOST}/v1`), true);
  assert.equal(isNvidiaOfficialHost("http://127.0.0.1:8088/v1"), false);
  assert.equal(isNvidiaOfficialHost("https://api.openai.com/v1"), false);
});

test("NVIDIA payload: enable_thinking false by default, json_object, role max_tokens", () => {
  const prev = process.env.LLM_CHECKER_THINKING;
  delete process.env.LLM_CHECKER_THINKING;
  try {
    assert.equal(isCheckerThinkingEnabled(), false);
    const inv = buildNvidiaChatBody({
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      messages: [{ role: "user", content: "x" }],
      role: "investigator",
    });
    assert.deepEqual(inv.response_format, { type: "json_object" });
    assert.deepEqual(inv.chat_template_kwargs, { enable_thinking: false });
    assert.equal(inv.max_tokens, investigatorMaxTokens());
    assert.equal(inv.max_tokens, 4096);
    assert.equal("reasoning_budget" in inv, false);

    const chk = buildNvidiaChatBody({
      model: "m",
      messages: [{ role: "user", content: "y" }],
      role: "checker",
    });
    assert.equal(chk.max_tokens, checkerMaxTokens());
    assert.equal(chk.max_tokens, 2048);
    assert.deepEqual(chk.chat_template_kwargs, { enable_thinking: false });
    assert.equal("reasoning_budget" in chk, false);
  } finally {
    if (prev === undefined) delete process.env.LLM_CHECKER_THINKING;
    else process.env.LLM_CHECKER_THINKING = prev;
  }
});

test("NVIDIA checker-only thinking when LLM_CHECKER_THINKING=true", () => {
  const prev = process.env.LLM_CHECKER_THINKING;
  process.env.LLM_CHECKER_THINKING = "true";
  try {
    assert.equal(isCheckerThinkingEnabled(), true);
    const chk = buildNvidiaChatBody({
      model: "m",
      messages: [{ role: "user", content: "y" }],
      role: "checker",
    });
    assert.deepEqual(chk.chat_template_kwargs, { enable_thinking: true });
    assert.equal(chk.max_tokens, CHECKER_THINKING_MAX_TOKENS);
    assert.equal(chk.max_tokens, 8192);
    assert.equal(chk.reasoning_budget, CHECKER_THINKING_REASONING_BUDGET);
    assert.equal(chk.reasoning_budget, 4096);

    const inv = buildNvidiaChatBody({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      role: "investigator",
    });
    assert.deepEqual(inv.chat_template_kwargs, { enable_thinking: false });
    assert.equal(inv.max_tokens, 4096);
    assert.equal("reasoning_budget" in inv, false);
  } finally {
    if (prev === undefined) delete process.env.LLM_CHECKER_THINKING;
    else process.env.LLM_CHECKER_THINKING = prev;
  }
});

test("mocked NVIDIA HTTP: correct URL, headers, and body fields", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fetchImpl: FetchLike = async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return jsonResponse(200, {
      id: "chatcmpl-live-id-abc",
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      choices: [{ message: { content: JSON.stringify({ kind: "stop", reason: "ok" }) } }],
    });
  };

  const res = await nvidiaChatCompletions(
    nvidiaConfig(),
    [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
    { role: "investigator" },
    fetchImpl,
  );

  assert.equal(seenUrl, `https://${NVIDIA_OFFICIAL_HOST}/v1/chat/completions`);
  assert.equal((seenInit?.headers as Record<string, string>)["Authorization"], "Bearer test-key-not-a-secret-for-unit-tests");
  const body = JSON.parse(String(seenInit?.body));
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.max_tokens, 4096);
  assert.equal(res.providerResponseId, "chatcmpl-live-id-abc");
  assert.equal(res.text.includes("stop"), true);
  // Must not surface reasoning fields even if present on the wire
  assert.equal("reasoning" in res, false);
});

test("mocked NVIDIA HTTP: missing id yields providerResponseId null; checker uses 2048", async () => {
  let body = "";
  const fetchImpl: FetchLike = async (_u, init) => {
    body = String(init?.body);
    return jsonResponse(200, {
      model: "m",
      choices: [{ message: { content: '{"kind":"stop","reason":"x"}' } }],
    });
  };
  const res = await nvidiaChatCompletions(nvidiaConfig(), [{ role: "user", content: "u" }], { role: "checker" }, fetchImpl);
  assert.equal(res.providerResponseId, null);
  assert.equal(JSON.parse(body).max_tokens, 2048);
});

test("mocked NVIDIA HTTP: empty content fails closed", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse(200, {
      id: "id-1",
      choices: [{ message: { content: "   ", reasoning_content: "should never be used" } }],
    });
  await assert.rejects(
    () => nvidiaChatCompletions(nvidiaConfig(), [{ role: "user", content: "u" }], { role: "investigator" }, fetchImpl),
    /empty content/,
  );
});

test("mocked NVIDIA HTTP: malformed envelope fails closed without raw body leak", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response("NOT_JSON {{{ secret-body", { status: 200, headers: { "Content-Type": "application/json" } });
  await assert.rejects(
    () => nvidiaChatCompletions(nvidiaConfig(), [{ role: "user", content: "u" }], { role: "investigator" }, fetchImpl),
    (err: Error) => {
      assert.match(err.message, /malformed JSON envelope/);
      assert.equal(err.message.includes("secret-body"), false);
      assert.equal(err.message.includes("NOT_JSON"), false);
      return true;
    },
  );
});

test("mocked NVIDIA HTTP: non-OK status fails without provider body", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ error: { message: "quota exploded raw detail" } }), { status: 429 });
  await assert.rejects(
    () => nvidiaChatCompletions(nvidiaConfig(), [{ role: "user", content: "u" }], { role: "investigator" }, fetchImpl),
    (err: Error) => {
      assert.match(err.message, /status 429/);
      assert.equal(err.message.includes("quota"), false);
      assert.equal(err.message.includes("raw detail"), false);
      return true;
    },
  );
});

test("mocked NVIDIA HTTP: oversize content fails closed", async () => {
  const huge = "x".repeat(MAX_ASSISTANT_CONTENT_CHARS + 1);
  const fetchImpl: FetchLike = async () =>
    jsonResponse(200, { id: "big", choices: [{ message: { content: huge } }] });
  await assert.rejects(
    () => nvidiaChatCompletions(nvidiaConfig(), [{ role: "user", content: "u" }], { role: "investigator" }, fetchImpl),
    /length limit/,
  );
});

test("createModelCallerFromConfig routes NVIDIA host to adapter", async () => {
  let hit = false;
  const fetchImpl: FetchLike = async () => {
    hit = true;
    return jsonResponse(200, {
      id: "rid-9",
      choices: [{ message: { content: JSON.stringify({ kind: "stop", reason: "done" }) } }],
    });
  };
  const caller = createModelCallerFromConfig(nvidiaConfig(), fetchImpl);
  const out = await caller([{ role: "user", content: "hi" }], { role: "investigator", callIndex: 1 });
  assert.equal(hit, true);
  assert.equal(out.providerResponseId, "rid-9");
});

test("strict JSON: trailing text after object is rejected (no salvage)", () => {
  assert.throws(() => extractJsonObject('{"kind":"stop","reason":"x"}\nThanks!'), /valid JSON|single JSON object/);
  assert.throws(() => extractJsonObject('Here:\n{"kind":"stop","reason":"x"}'), /single JSON object/);
  assert.throws(
    () =>
      parseInvestigatorDecision(
        JSON.stringify({ kind: "stop", reason: "ok" }) + "\nextra commentary",
      ),
  );
  // Pure object still works
  assert.equal(parseInvestigatorDecision('{"kind":"stop","reason":"enough"}').kind, "stop");
});

test("mocked NVIDIA HTTP: finish_reason length rejected before content use", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse(200, {
      id: "trunc",
      choices: [
        {
          finish_reason: "length",
          message: { content: JSON.stringify({ kind: "stop", reason: "looks-valid-json" }) },
        },
      ],
    });
  await assert.rejects(
    () => nvidiaChatCompletions(nvidiaConfig(), [{ role: "user", content: "u" }], { role: "investigator" }, fetchImpl),
    /finish_reason rejected: length/,
  );
});

test("mocked NVIDIA HTTP: finish_reason content_filter rejected", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse(200, {
      id: "filt",
      choices: [
        {
          finish_reason: "content_filter",
          message: { content: JSON.stringify({ kind: "stop", reason: "ok" }) },
        },
      ],
    });
  await assert.rejects(
    () => nvidiaChatCompletions(nvidiaConfig(), [{ role: "user", content: "u" }], { role: "investigator" }, fetchImpl),
    /finish_reason rejected: content_filter/,
  );
});

test("reasoning_content is never returned as text", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse(200, {
      id: "id-r",
      choices: [
        {
          message: {
            content: JSON.stringify({ kind: "stop", reason: "ok" }),
            reasoning_content: "SECRET_CHAIN",
            reasoning: "SECRET_CHAIN2",
          },
        },
      ],
    });
  const res = await nvidiaChatCompletions(nvidiaConfig(), [{ role: "user", content: "u" }], { role: "investigator" }, fetchImpl);
  assert.equal(res.text.includes("SECRET_CHAIN"), false);
  assert.match(res.text, /"kind":"stop"/);
});
