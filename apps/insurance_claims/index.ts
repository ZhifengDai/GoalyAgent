import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createOpenAIModel } from "../../agent-loop/openai-model.ts";
import { handleMessage } from "./harness/handler.ts";
import { getEvents } from "./session/events.ts";
import { reduceSessionEvents } from "./session/facts.ts";
import { deriveSopState } from "./session/state.ts";
import type { Message } from "../../agent-loop/types.ts";

const SESSION_ID = `session_${Date.now()}`;

const conversationModel = createOpenAIModel({ model: "gpt-4.1" });

const history: Message[] = [];

const rl = readline.createInterface({ input: stdin, output: stdout });

console.log("\n── Insurance Claims Support Agent ──");
console.log("Type your message and press Enter. Ctrl+C to exit.\n");

async function chat(userInput: string): Promise<void> {
  const nowIso = new Date().toISOString();

  const result = await handleMessage({
    sessionId: SESSION_ID,
    userMessage: userInput,
    model: conversationModel,
    priorMessages: history,
    nowIso,
    emit: async (event) => {
      if (event.type === "text_delta") {
        process.stdout.write(event.delta);
      }
      if (event.type === "tool_execution_start") {
        process.stderr.write(`\n[TOOL] ${event.call.name} ${JSON.stringify(event.call.arguments)}\n`);
      }
      if (event.type === "tool_execution_end") {
        process.stderr.write(`[TOOL RESULT] ${JSON.stringify(event.result.content).slice(0, 200)}\n`);
      }
    },
  });

  // Persist this turn's messages into history for the next call.
  // result.context.messages already contains the full transcript of this turn
  // (user message + assistant + tool results). Append everything after priorMessages.
  const newMessages = result.context.messages.slice(history.length);
  history.push(...newMessages);

  // Compact one-line status after each turn.
  const facts = reduceSessionEvents(getEvents(SESSION_ID));
  const state = deriveSopState(facts);
  const fields = Object.entries(facts.identity.provided_fields).map(([k, v]) => `${k}=${v?.value}`).join(", ");
  process.stderr.write(`\n[STATE] phase=${state.phase} fields={${fields}} rev=${facts.identity.identity_revision} verification=${facts.identity.verification?.status ?? facts.identity.verification_failure?.status ?? "null"}\n`);

  // End the assistant's turn with a newline if streaming was used.
  const lastAssistant = result.context.messages.findLast(m => m.role === "assistant");
  if (lastAssistant && "content" in lastAssistant && lastAssistant.content) {
    process.stdout.write("\n");
  }
}

async function main(): Promise<void> {
  while (true) {
    const userInput = await rl.question("\nYou: ").catch(() => null);
    if (userInput === null || userInput.trim().toLowerCase() === "exit") {
      console.log("\nGoodbye.");
      rl.close();
      break;
    }
    if (!userInput.trim()) continue;

    process.stdout.write("\nAgent: ");
    try {
      await chat(userInput.trim());
    } catch (err) {
      console.error("\n[Error]", err instanceof Error ? err.message : err);
    }
  }
}

main();
