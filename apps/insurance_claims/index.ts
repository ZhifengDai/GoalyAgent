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

  // Print session facts to stderr after every turn for debugging.
  const facts = reduceSessionEvents(getEvents(SESSION_ID));
  const state = deriveSopState(facts);
  const debugSnapshot = {
    phase: state.phase,
    identity_revision: facts.identity.identity_revision,
    provided_fields: Object.fromEntries(
      Object.entries(facts.identity.provided_fields).map(([k, v]) => [k, v?.value])
    ),
    pending_clarification: facts.identity.pending_clarification,
    verification: facts.identity.verification?.status ?? null,
    verification_failure: facts.identity.verification_failure?.status ?? null,
    case_hints: facts.case_hints,
    case_resolution: facts.case_resolution,
    customer_decisions: facts.customer_decisions,
  };
  process.stderr.write(`\n[SESSION FACTS]\n${JSON.stringify(debugSnapshot, null, 2)}\n`);

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
