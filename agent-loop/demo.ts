import { runAgentLoop } from "./agent-loop.ts";
import type { Context, ModelFn } from "./types.ts";

// Mock facts are deliberately explicit: this is a loop demo, not real identity verification.
const facts = { identityVerified: false };
const context: Context = {
  systemPrompt: "身份通过前不能查询案件。回答必须依据工具结果。",
  runtimeContext: {},
  messages: [],
  tools: [{
    name: "get_claim_status",
    description: "读取当前会话授权案件状态（模拟）",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: args => {
      if (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
        throw new Error("Expected empty arguments");
      }
    },
    execute: async () => ({ content: "模拟案件状态：denied", data: { status: "denied" } }),
  }],
};
let sequence = 0;
const model: ModelFn = async request => {
  const last = request.messages.at(-1);
  if (last?.role === "toolResult") {
    return { role: "assistant", content: last.isError
      ? "查询被阻止，请先完成身份验证。"
      : `根据工具返回：${last.content}。`, toolCalls: [], stopReason: "stop" };
  }
  return {
    role: "assistant", content: "", stopReason: "tool_calls",
    toolCalls: [{ id: `call_${++sequence}`, name: "get_claim_status", arguments: {} }],
  };
};

const run = async (input: string) => {
  const result = await runAgentLoop(input, context, {
    model,
    prepareRequest: ctx => { ctx.runtimeContext = { identityVerified: facts.identityVerified }; },
    beforeToolCall: async () => facts.identityVerified ? undefined
      : { block: true, reason: "Identity verification required" },
    emit: event => {
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.content) {
        console.log(`assistant: ${event.message.content}`);
      } else if (event.type !== "message_end") console.log(event.type);
    },
  });
  console.log(`result: ${result.reason}, model turns: ${result.turns}\n`);
};

console.log("场景一：未验证，模型尝试查案件，被 Harness 拦截。");
await run("为什么拒赔？");
console.log("场景二：测试夹具设为已验证，查询执行并回传模型。");
facts.identityVerified = true;
await run("现在查询状态。");
