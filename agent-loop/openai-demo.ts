import { runAgentLoop } from "./agent-loop.ts";
import { createOpenAIModel } from "./openai-model.ts";
import type { Context } from "./types.ts";

const input = process.argv.slice(2).join(" ").trim();
if (!input) {
  console.error('Usage: node agent-loop/openai-demo.ts "Your message"');
  process.exitCode = 2;
} else {
  const context: Context = {
    systemPrompt: "You are a concise assistant. Answer the user's question in their language.",
    runtimeContext: {},
    messages: [],
    tools: [],
  };
  const result = await runAgentLoop(input, context, {
    model: createOpenAIModel(),
  });
  if (result.reason === "error" || result.reason === "aborted") {
    console.error(result.error ?? result.reason);
    process.exitCode = 1;
  } else {
    const reply = result.context.messages.findLast(message => message.role === "assistant");
    if (reply?.role === "assistant") console.log(reply.content);
  }
}
