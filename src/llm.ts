// Answer path. Two labeled modes:
//   retrieval-only (default): the answer is assembled from retrieved
//     memories; zero network access, zero keys.
//   model mode: when LLM_API_KEY is set, the reinjection block goes into a
//     real model prompt through the OpenAI-compatible client (NVIDIA Nemotron
//     by default, or Meterless Runtime). See src/llm-client.ts.

import { chat, loadLLMConfig } from "./llm-client.ts";

export interface AnswerResult {
  mode: "retrieval-only" | "model";
  text: string;
  model?: string;
}

export async function answer(question: string, memoryContext: string, memories: { relevance: number; content: string }[]): Promise<AnswerResult> {
  const config = loadLLMConfig();
  if (!config) return { mode: "retrieval-only", text: retrievalOnly(question, memories) };
  const result = await chat(config, [
    {
      role: "user",
      content: `${memoryContext}\n\nAnswer using ONLY the memory context above. Cite memory ids inline.\n\nQuestion: ${question}`,
    },
  ], { maxTokens: 400 });
  return { mode: "model", text: result.text, model: `${result.model} via ${result.baseUrl}` };
}

function retrievalOnly(question: string, memories: { relevance: number; content: string }[]): string {
  if (memories.length === 0) {
    return `Nothing in memory answers "${question}" yet. Teach me: notebook remember "<fact>"`;
  }
  const lines = [`Based on what I remember about "${question}":`];
  for (const m of memories) lines.push(`- ${m.content} (relevance ${m.relevance.toFixed(2)})`);
  return lines.join("\n");
}
