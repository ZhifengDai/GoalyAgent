import * as readline from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { stdin, stdout } from "node:process";
import { createOpenAIModel } from "../../agent-loop/openai-model.ts";
import { handleMessage } from "./harness/handler.ts";
import { getEvents } from "./session/events.ts";
import { reduceSessionEvents } from "./session/facts.ts";
import { deriveSopState } from "./session/state.ts";
import type { Message } from "../../agent-loop/types.ts";

const SESSION_ID = `session_${Date.now()}`;

// Log file: logs/insurance-<session>.log (created next to index.ts)
const LOG_DIR = path.join(import.meta.dirname, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `${SESSION_ID}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(line: string): void {
  const ts = new Date().toISOString();
  logStream.write(`[${ts}] ${line}\n`);
}

const conversationModel = createOpenAIModel({});

const history: Message[] = [];

const rl = readline.createInterface({ input: stdin, output: stdout });

console.log("\n── Insurance Claims Support Agent ──");
console.log(`Logs → ${LOG_FILE}`);
console.log("Type your message and press Enter. Ctrl+C to exit.\n");
log(`=== Session started: ${SESSION_ID} ===`);

async function chat(userInput: string): Promise<void> {
  const nowIso = new Date().toISOString();
  log(`[USER] ${userInput}`);

  let agentReply = "";
  const result = await handleMessage({
    sessionId: SESSION_ID,
    userMessage: userInput,
    model: conversationModel,
    priorMessages: history,
    nowIso,
    emit: async (event) => {
      if (event.type === "text_delta") {
        process.stdout.write(event.delta);
        agentReply += event.delta;
      }
      if (event.type === "tool_execution_start") {
        log(`[TOOL] ${event.call.name} ${JSON.stringify(event.call.arguments)}`);
      }
      if (event.type === "tool_execution_end") {
        log(`[TOOL RESULT] ${JSON.stringify(event.result.content).slice(0, 500)}`);
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
  log(`[AGENT] ${agentReply.trim()}`);
  log(`[STATE] phase=${state.phase} fields={${fields}} rev=${facts.identity.identity_revision} verification=${facts.identity.verification?.status ?? facts.identity.verification_failure?.status ?? "null"}`);

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
      log("=== Session ended ===");
      logStream.end();
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
