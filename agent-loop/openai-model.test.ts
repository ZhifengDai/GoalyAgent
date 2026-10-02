import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "./agent-loop.ts";
import { createOpenAIModel } from "./openai-model.ts";
import type { Context, Json, Tool } from "./types.ts";

const lookup: Tool = {
  name: "lookup", description: "Lookup an item",
  parameters: {
    type: "object", properties: { id: { type: "string" } },
    required: ["id"], additionalProperties: false,
  },
  validate(args: Json) {
    if (args === null || typeof args !== "object" || Array.isArray(args) ||
        typeof args.id !== "string") throw new Error("id required");
  },
  async execute(args) { return { content: `item ${String((args as { id: string }).id)}` }; },
};

test("GPT-4.1 request, function call, tool result and second request round trip", async () => {
  const requests: Record<string, unknown>[] = [];
  let count = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(input, "https://api.openai.com/v1/chat/completions");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    count++;
    return Response.json(count === 1 ? {
      choices: [{ finish_reason: "tool_calls", message: {
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"id":"CL-2048"}' } }],
      } }],
    } : { choices: [{ finish_reason: "stop", message: { content: "Claim found" } }] });
  };
  const ctx: Context = {
    systemPrompt: "rules", runtimeContext: { phase: "PROCESS_CASE" }, messages: [], tools: [lookup],
  };
  const result = await runAgentLoop("Check claim", ctx, {
    model: createOpenAIModel({ apiKey: "test-key", fetchImpl: fakeFetch }),
  });
  assert.equal(result.reason, "complete");
  assert.equal(result.turns, 2);
  assert.equal(requests[0].model, "gpt-4.1");
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].parallel_tool_calls, false);
  const firstMessages = requests[0].messages as Record<string, unknown>[];
  assert.equal(firstMessages[0].role, "system");
  assert.equal(firstMessages[1].role, "developer");
  const secondMessages = requests[1].messages as Record<string, unknown>[];
  assert.equal(secondMessages.at(-1)?.role, "tool");
  assert.equal(secondMessages.at(-1)?.tool_call_id, "call_1");
  assert.equal((secondMessages.at(-2)?.tool_calls as Record<string, unknown>[])[0].id, "call_1");
});

test("explicit model and base URL reach the request", async () => {
  let seen = false;
  const model = createOpenAIModel({
    apiKey: "test-key", model: "gpt-4.1-2025-04-14", baseUrl: "https://proxy.example/v1/",
    fetchImpl: async (input, init) => {
      assert.equal(input, "https://proxy.example/v1/chat/completions");
      assert.equal((JSON.parse(String(init?.body)) as { model: string }).model, "gpt-4.1-2025-04-14");
      seen = true;
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
    },
  });
  const result = await runAgentLoop("hi", {
    systemPrompt: "rules", runtimeContext: {}, messages: [], tools: [],
  }, { model });
  assert.equal(result.reason, "complete");
  assert.equal(seen, true);
});

test("missing key and API errors stop without exposing response body", async () => {
  const ctx: Context = { systemPrompt: "rules", runtimeContext: {}, messages: [], tools: [] };
  const missing = await runAgentLoop("hi", ctx, {
    model: createOpenAIModel({ apiKey: "" }),
  });
  assert.equal(missing.reason, "error");
  assert.match(missing.error ?? "", /OPENAI_API_KEY/);
  const failed = await runAgentLoop("hi", ctx, {
    model: createOpenAIModel({
      apiKey: "test-key",
      fetchImpl: async () => new Response("secret server body", { status: 401 }),
    }),
  });
  assert.equal(failed.reason, "error");
  assert.match(failed.error ?? "", /HTTP 401/);
  assert.doesNotMatch(failed.error ?? "", /secret/);
});

test("malformed function arguments reach tool validation as an error result", async () => {
  let executed = false;
  let count = 0;
  const model = createOpenAIModel({ apiKey: "test-key", fetchImpl: async () => {
    count++;
    return Response.json(count === 1
      ? { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
        { id: "c1", function: { name: "lookup", arguments: "{" } },
      ] } }] }
      : { choices: [{ finish_reason: "stop", message: { content: "Please retry" } }] });
  } });
  const result = await runAgentLoop("hi", {
    systemPrompt: "rules", runtimeContext: {}, messages: [],
    tools: [{ ...lookup, execute: async () => { executed = true; return { content: "bad" }; } }],
  }, { model });
  assert.equal(result.reason, "complete");
  assert.equal(executed, false);
  assert.equal(result.context.messages.find(message => message.role === "toolResult")?.isError, true);
});

test("length-finished function calls are not executed", async () => {
  let executed = false;
  let count = 0;
  const model = createOpenAIModel({ apiKey: "test-key", fetchImpl: async () => {
    count++;
    return Response.json(count === 1
      ? { choices: [{ finish_reason: "length", message: { content: null, tool_calls: [
        { id: "c1", function: { name: "lookup", arguments: "{}" } },
      ] } }] }
      : { choices: [{ finish_reason: "stop", message: { content: "done" } }] });
  } });
  const result = await runAgentLoop("hi", {
    systemPrompt: "rules", runtimeContext: {}, messages: [],
    tools: [{ ...lookup, execute: async () => { executed = true; return { content: "bad" }; } }],
  }, { model });
  assert.equal(result.reason, "complete");
  assert.equal(executed, false);
});
